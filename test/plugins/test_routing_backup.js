/*    Copyright 2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict'

// Off-box suite for the global routing plugin. test_routing.js drives real interfaces on a box,
// this one records the route commands instead.

let chai = require('chai');
let expect = chai.expect;

const stub = require('./stub_exec.js');
// util/routing.js captures exec when it is required, so load it again under the stub with the
// plugin, then drop it so the suites that run later get the real one
const routingPath = require.resolve('../../util/routing.js');
delete require.cache[routingPath];
const RoutingPlugin = stub.load(require.resolve('../../plugins/routing/routing_plugin.js'));
delete require.cache[routingPath];
const pl = require('../../plugins/plugin_loader.js');
const event = require('../../core/event.js');

const GOLDEN = require('./routing_golden.json');

function fakeIntf(name, idx, opts) {
  const o = Object.assign({ready: true, carrier: 1, present: true, ip6: true}, opts);
  return {
    name,
    o,
    networkConfig: {meta: {name: `WAN ${idx}`, uuid: `uuid-${name}`}},
    _publishChangeTo() {},
    async state() {
      return {ip4s: [`10.0.${idx}.2/24`], ip6: o.ip6 ? [`2001:db8:${idx}::2/64`] : null, carrier: o.carrier};
    },
    async getDns4Nameservers() { return [`10.0.${idx}.53`]; },
    async getRoutableDns6Nameservers() { return o.ip6 ? [`2001:db8:${idx}::53`] : []; },
    async isInterfacePresent() { return o.present; },
    async getIPv4Addresses() { return [`10.0.${idx}.2`]; },
    isReady() { return o.ready; },
  };
}

const origGetPluginInstance = pl.getPluginInstance;
const origScheduleReapply = pl.scheduleReapply;
const origPublishChangeApplied = pl.publishChangeApplied;
let reapplies = 0;

const LB_BACKUP = {type: 'load_balance', nextHops: [{viaIntf: 'eth0', weight: 50}, {viaIntf: 'eth1', weight: 50}], bakIntfs: ['wlan0'], failback: true};
const LB_TWO_BACKUPS = {type: 'load_balance', nextHops: [{viaIntf: 'eth0', weight: 50}, {viaIntf: 'eth1', weight: 50}], bakIntfs: ['wlan0', 'wlan1'], failback: true};

// index of the first recorded command containing needle
const at = (needle) => stub.calls.findIndex(c => c.includes(needle));

// wans: [{name, ready, carrier, present, ip6}], in config order
function setup(def, wans, pluginConfig = {smooth_failover: true}) {
  const intfs = {};
  wans.forEach((w, i) => {
    intfs[w.name] = fakeIntf(w.name, i + 1, w);
    stub.outputFor(`ip -4 r show table ${w.name}_default`, `10.0.${i + 1}.1`);
    if (w.ip6 !== false)
      stub.outputFor(`ip -6 r show table ${w.name}_default`, `2001:db8:${i + 1}::1`);
  });
  pl.getPluginInstance = (category, name) => category === 'interface' ? intfs[name] : undefined;
  const plugin = stub.build(RoutingPlugin, 'global', {default: def});
  plugin.init(pluginConfig);
  plugin.published = [];
  plugin.scheduled = [];
  plugin.publishWANConnChange = async (desc) => { plugin.published.push(desc); };
  plugin.processWANConnChange = async () => {};
  plugin.scheduleApplyActiveGlobalDefaultRouting = (desc) => { plugin.scheduled.push(desc); };
  // seed ready/active/carrier by seq, apply() inherits them
  plugin._wanStatus = {};
  wans.forEach((w, seq) => {
    plugin._wanStatus[`seed${seq}`] = {seq, ready: w.ready !== false, active: w.active === true};
  });
  return {plugin, intfs};
}

// lets the enrich-then-publish promise chains settle
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

function connCheck(plugin, intf) {
  plugin.onEvent(event.buildEvent(event.EVENT_WAN_CONN_CHECK, {intf, failures: []}));
}

describe('Test global routing plugin', function() {
  this.timeout(30000);

  beforeEach(() => {
    stub.reset();
    // the remove loops run until a delete fails
    stub.failOn(' route del ');
    reapplies = 0;
    pl.scheduleReapply = () => { reapplies++; };
    pl.publishChangeApplied = async () => {};
  });

  after(() => {
    pl.getPluginInstance = origGetPluginInstance;
    pl.scheduleReapply = origScheduleReapply;
    pl.publishChangeApplied = origPublishChangeApplied;
  });

  describe('golden command sequences', function() {
    it('primary_standby with smooth_failover, first apply', async() => {
      const {plugin} = setup({type: 'primary_standby', viaIntfs: ['eth0', 'eth1'], failback: true},
        [{name: 'eth0'}, {name: 'eth1', ready: false, carrier: 0}]);
      await plugin.apply();
      expect(stub.calls).to.deep.equal(GOLDEN.ps_apply);
      expect(plugin._wanStatus.eth0).to.include({seq: 0, ready: true, active: true, inUse: true});
      expect(plugin._wanStatus.eth1).to.include({seq: 1, ready: false, active: false, inUse: false});
    });

    it('primary_standby with smooth_failover, failover to the second WAN', async() => {
      const {plugin, intfs} = setup({type: 'primary_standby', viaIntfs: ['eth0', 'eth1'], failback: true},
        [{name: 'eth0'}, {name: 'eth1', ready: false, carrier: 0}]);
      await plugin.apply();
      stub.calls.length = 0;
      plugin._wanStatus.eth0.ready = false;
      intfs.eth0.o.carrier = 0;
      plugin._wanStatus.eth1.ready = true;
      intfs.eth1.o.carrier = 1;
      const switched = await plugin._applyActiveGlobalDefaultRouting(true);
      expect(switched).to.be.true;
      expect(stub.calls).to.deep.equal(GOLDEN.ps_failover);
      expect(plugin._wanStatus.eth0).to.include({active: false});
      expect(plugin._wanStatus.eth1).to.include({active: true, inUse: true});
    });

    it('load_balance with one nextHop unready, first apply', async() => {
      const {plugin} = setup({type: 'load_balance', nextHops: [{viaIntf: 'eth0', weight: 50}, {viaIntf: 'eth1', weight: 50}]},
        [{name: 'eth0'}, {name: 'eth1', ready: false}]);
      await plugin.apply();
      expect(stub.calls).to.deep.equal(GOLDEN.lb_apply);
      expect(plugin._wanStatus.eth0).to.include({seq: 0, ready: true, active: true, inUse: true, weight: 50});
      expect(plugin._wanStatus.eth1).to.include({seq: 1, ready: false, active: false, inUse: false, weight: 50});
    });

    it('load_balance with every nextHop unready marks the first WAN with carrier in use', async() => {
      const {plugin} = setup({type: 'load_balance', nextHops: [{viaIntf: 'eth0', weight: 50}, {viaIntf: 'eth1', weight: 50}]},
        [{name: 'eth0', ready: false, carrier: 0}, {name: 'eth1', ready: false}]);
      await plugin.apply();
      expect(stub.calls).to.deep.equal(GOLDEN.lb_all_down);
      expect(plugin._wanStatus.eth0).to.include({active: false, inUse: false});
      expect(plugin._wanStatus.eth1).to.include({active: false, inUse: true});
    });
  });

  describe('missing WAN interface at apply', function() {
    it('load_balance reports a lost nextHop as switched', async() => {
      const {plugin} = setup({type: 'load_balance', nextHops: [{viaIntf: 'eth0', weight: 50}, {viaIntf: 'eth1', weight: 50}]},
        [{name: 'eth0'}, {name: 'eth1', present: false}]);
      await plugin.apply();
      await settle();
      expect(plugin.published.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth1', false, true]]);
      expect(plugin._wanStatus.eth1).to.include({ready: false, active: false});
    });

    it('primary_standby reports a lost active WAN as switched', async() => {
      const {plugin} = setup({type: 'primary_standby', viaIntfs: ['eth0', 'eth1']},
        [{name: 'eth0', active: true, present: false}, {name: 'eth1'}]);
      await plugin.apply();
      await settle();
      expect(plugin.published.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth0', false, true]]);
    });

    it('primary_standby reports a lost standby WAN as not switched', async() => {
      const {plugin} = setup({type: 'primary_standby', viaIntfs: ['eth0', 'eth1']},
        [{name: 'eth0', active: true}, {name: 'eth1', present: false}]);
      await plugin.apply();
      await settle();
      expect(plugin.published.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth1', false, false]]);
    });

    it('single reports a lost WAN as not switched', async() => {
      const {plugin} = setup({type: 'single', viaIntf: 'eth0'}, [{name: 'eth0', active: true, present: false}]);
      await plugin.apply();
      await settle();
      expect(plugin.published.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth0', false, false]]);
    });
  });

  describe('WAN_CONN_CHECK decisions', function() {
    it('primary_standby schedules an apply when the active WAN goes down', async() => {
      const {plugin, intfs} = setup({type: 'primary_standby', viaIntfs: ['eth0', 'eth1'], failback: true}, [{name: 'eth0'}, {name: 'eth1'}]);
      await plugin.apply();
      intfs.eth0.o.ready = false;
      connCheck(plugin, 'eth0');
      expect(plugin.scheduled.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth0', false, true]]);
    });

    it('primary_standby only publishes when a lower ranked WAN comes back', async() => {
      const {plugin, intfs} = setup({type: 'primary_standby', viaIntfs: ['eth0', 'eth1'], failback: true},
        [{name: 'eth0'}, {name: 'eth1', ready: false}]);
      await plugin.apply();
      intfs.eth1.o.ready = true;
      connCheck(plugin, 'eth1');
      await settle();
      expect(plugin.scheduled).to.be.empty;
      expect(plugin.published.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth1', true, false]]);
    });

    it('primary_standby fails back when a higher ranked WAN comes back', async() => {
      const {plugin, intfs} = setup({type: 'primary_standby', viaIntfs: ['eth0', 'eth1'], failback: true},
        [{name: 'eth0', ready: false}, {name: 'eth1'}]);
      await plugin.apply();
      intfs.eth0.o.ready = true;
      connCheck(plugin, 'eth0');
      expect(plugin.scheduled.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth0', true, true]]);
    });

    it('primary_standby without failback only publishes when a higher ranked WAN comes back', async() => {
      const {plugin, intfs} = setup({type: 'primary_standby', viaIntfs: ['eth0', 'eth1'], failback: false},
        [{name: 'eth0', ready: false}, {name: 'eth1'}]);
      await plugin.apply();
      intfs.eth0.o.ready = true;
      connCheck(plugin, 'eth0');
      await settle();
      expect(plugin.scheduled).to.be.empty;
      expect(plugin.published.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth0', true, false]]);
    });

    it('load_balance schedules an apply when a nextHop comes back', async() => {
      const {plugin, intfs} = setup({type: 'load_balance', nextHops: [{viaIntf: 'eth0', weight: 50}, {viaIntf: 'eth1', weight: 50}]},
        [{name: 'eth0'}, {name: 'eth1', ready: false}]);
      await plugin.apply();
      intfs.eth1.o.ready = true;
      connCheck(plugin, 'eth1');
      expect(plugin.scheduled.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth1', true, true]]);
    });

    it('load_balance schedules an apply when an active nextHop goes down', async() => {
      const {plugin, intfs} = setup({type: 'load_balance', nextHops: [{viaIntf: 'eth0', weight: 50}, {viaIntf: 'eth1', weight: 50}]},
        [{name: 'eth0'}, {name: 'eth1'}]);
      await plugin.apply();
      intfs.eth1.o.ready = false;
      connCheck(plugin, 'eth1');
      expect(plugin.scheduled.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth1', false, true]]);
    });
  });

  describe('load_balance backup WANs', function() {
    it('registers backups after the nextHops, skipping duplicates and a non-array value', async() => {
      const {plugin} = setup(Object.assign({}, LB_BACKUP, {bakIntfs: ['wlan0', 'eth1', 'wlan0']}),
        [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0'}]);
      await plugin.apply();
      expect(Object.keys(plugin._wanStatus)).to.deep.equal(['eth0', 'eth1', 'wlan0']);
      expect(plugin._wanStatus.wlan0).to.include({seq: 2, backup: true});
      expect(plugin._wanStatus.wlan0.weight).to.be.undefined;
      expect(plugin._wanStatus.eth1.backup).to.be.undefined;

      const other = setup(Object.assign({}, LB_BACKUP, {bakIntfs: 'wlan0'}), [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0'}]);
      await other.plugin.apply();
      expect(Object.keys(other.plugin._wanStatus)).to.deep.equal(['eth0', 'eth1']);
    });

    it('fails the apply when a backup has no interface plugin', async() => {
      const {plugin} = setup(Object.assign({}, LB_BACKUP, {bakIntfs: ['wlan9']}), [{name: 'eth0'}, {name: 'eth1'}]);
      let error = null;
      await plugin.apply().catch((err) => { error = err; });
      expect(error).to.contain('wlan9');
    });

    it('reports a lost backup as switched only if it was active', async() => {
      const standby = setup(LB_BACKUP, [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0', present: false}]);
      await standby.plugin.apply();
      const active = setup(LB_BACKUP, [{name: 'eth0', ready: false}, {name: 'eth1', ready: false}, {name: 'wlan0', active: true, present: false}]);
      await active.plugin.apply();
      await settle();
      expect(standby.plugin.published.map(d => [d.intf, d.wanSwitched])).to.deep.equal([['wlan0', false]]);
      expect(active.plugin.published.map(d => [d.intf, d.wanSwitched])).to.deep.equal([['wlan0', true]]);
    });

    it('keeps a ready backup on standby behind the multipath route, without IPv6 or DNS routes', async() => {
      const {plugin} = setup(LB_BACKUP, [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0'}]);
      await plugin.apply();
      expect(plugin._wanStatus.wlan0).to.include({active: false, inUse: false});
      expect(plugin._wanStatus.eth0).to.include({active: true, inUse: true});
      expect(stub.calls).to.include('sudo ip -4 route add unicast default via 10.0.3.1 dev wlan0 table global_default preference 3');
      expect(stub.calls).to.include('sudo ip -4 route add unicast default via 10.0.3.1 dev wlan0 table main preference 3');
      expect(stub.calls).to.include('sudo ip -4 route add unicast 10.0.3.0/24 dev wlan0 table global_local preference 3');
      // no DNS host route and nothing IPv6 through the standby backup
      expect(stub.matching('10.0.3.53')).to.be.empty;
      expect(stub.matching('2001:db8:3:')).to.be.empty;
      // the backup is installed only once the multipath route is in place
      const multipath = at('route add default table main metric 1 nexthop');
      expect(multipath).to.be.above(-1);
      expect(at('dev wlan0')).to.be.above(multipath);
    });

    it('lets the first ready backup take over when every nextHop is down', async() => {
      const {plugin} = setup(LB_TWO_BACKUPS, [{name: 'eth0', ready: false}, {name: 'eth1', ready: false, carrier: 0},
        {name: 'wlan0', ready: false}, {name: 'wlan1'}]);
      await plugin.apply();
      expect(plugin._wanStatus.wlan1).to.include({active: true, inUse: true});
      expect(plugin._wanStatus.wlan0).to.include({active: false, inUse: false});
      expect(stub.calls).to.include('sudo ip -4 route add unicast default via 10.0.4.1 dev wlan1 table main preference 4');
      expect(stub.calls).to.include('sudo ip -6 route add unicast default via 2001:db8:4::1 dev wlan1 table main preference 4');
      expect(stub.calls).to.include('sudo ip -4 route add unicast 10.0.4.53 via 10.0.4.1 dev wlan1 table main preference 4');
      expect(stub.calls).to.include('sudo ip -6 route add unicast 2001:db8:4::53 via 2001:db8:4::1 dev wlan1 table main preference 4');
      expect(stub.matching('add unicast default via 2001:db8:3::1')).to.be.empty;
    });

    it('ranks a ready backup below the multipath route and an unready backup below the unready nextHops', async() => {
      const {plugin} = setup(LB_TWO_BACKUPS, [{name: 'eth0', ready: false}, {name: 'eth1', ready: false},
        {name: 'wlan0'}, {name: 'wlan1', ready: false}]);
      await plugin.apply();
      const metricOf = (dev) => Number(stub.calls.find(c => c.includes(`add unicast default via`) && c.includes(`dev ${dev} table main`)).split('preference ')[1]);
      // multipath (1) < ready backup (seq+1) < unready nextHops (101+seq) < unready backup (101+seq, higher seq)
      expect(metricOf('wlan0')).to.equal(3);
      expect(metricOf('eth0')).to.equal(101);
      expect(metricOf('eth1')).to.equal(102);
      expect(metricOf('wlan1')).to.equal(104);
    });

    it('drops the backup and its DNS and IPv6 routes when a nextHop comes back', async() => {
      const {plugin} = setup(LB_BACKUP, [{name: 'eth0', ready: false}, {name: 'eth1', ready: false}, {name: 'wlan0'}]);
      await plugin.apply();
      expect(plugin._wanStatus.wlan0.active).to.be.true;
      stub.calls.length = 0;
      plugin._wanStatus.eth0.ready = true;
      const switched = await plugin._applyActiveGlobalDefaultRouting(true);
      expect(switched).to.be.true;
      expect(plugin._wanStatus.wlan0).to.include({active: false, inUse: false});
      expect(stub.calls).to.include('sudo ip -4 route del unicast 10.0.3.53 via 10.0.3.1 dev wlan0 table main');
      expect(stub.calls).to.include('sudo ip -6 route del unicast 2001:db8:3::53 via 2001:db8:3::1 dev wlan0 table main');
      expect(stub.matching('add unicast 10.0.3.53')).to.be.empty;
      expect(stub.matching('add unicast default via 2001:db8:3::1')).to.be.empty;
      expect(plugin._dnsRoutes.wlan0).to.be.empty;
    });

    it('reports the takeover by a backup as a WAN switch', async() => {
      const {plugin} = setup(LB_BACKUP, [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0'}]);
      await plugin.apply();
      expect(plugin._wanStatus.wlan0.active).to.be.false;
      plugin._wanStatus.eth0.ready = false;
      plugin._wanStatus.eth1.ready = false;
      const switched = await plugin._applyActiveGlobalDefaultRouting(true);
      expect(switched).to.be.true;
      expect(plugin._wanStatus.wlan0).to.include({active: true, inUse: true});
      expect(plugin._getActiveWANNames()).to.deep.equal(['wlan0']);
    });

    it('removes the DNS routes a former nextHop left in main when it becomes a backup', async() => {
      const {plugin} = setup({type: 'load_balance', nextHops: [{viaIntf: 'eth0', weight: 50}, {viaIntf: 'eth1', weight: 50}, {viaIntf: 'wlan0', weight: 50}]},
        [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0'}]);
      await plugin.apply();
      const dnsRouteAdds = () => stub.calls.filter(c => /(add|replace) unicast (10\.0\.3\.53|2001:db8:3::53) /.test(c));
      expect(dnsRouteAdds()).to.not.be.empty;
      stub.calls.length = 0;
      plugin.networkConfig = {default: LB_BACKUP};
      await plugin.apply();
      expect(plugin._wanStatus.wlan0).to.include({backup: true, active: false});
      expect(stub.calls).to.include('sudo ip -4 route del unicast 10.0.3.53 via 10.0.3.1 dev wlan0 table main');
      expect(stub.calls).to.include('sudo ip -6 route del unicast 2001:db8:3::53 via 2001:db8:3::1 dev wlan0 table main');
      expect(dnsRouteAdds()).to.be.empty;
      expect(plugin._dnsRoutes.wlan0 || []).to.be.empty;
    });

    it('keeps the backup selection on an apply for one address family', async() => {
      const {plugin} = setup(Object.assign({}, LB_TWO_BACKUPS, {failback: false}), [{name: 'eth0', ready: false}, {name: 'eth1', ready: false},
        {name: 'wlan0', ready: false}, {name: 'wlan1'}]);
      await plugin.apply();
      expect(plugin._wanStatus.wlan1.active).to.be.true;
      plugin._wanStatus.wlan0.ready = true;
      await plugin._applyActiveGlobalDefaultRouting(true, 6);
      expect(plugin._wanStatus.wlan1.active).to.be.true;
      expect(plugin._wanStatus.wlan0.active).to.be.false;
      await plugin._applyActiveGlobalDefaultRouting(true, 4);
      expect(plugin._wanStatus.wlan1.active).to.be.true;
      await plugin._applyActiveGlobalDefaultRouting(true);
      expect(plugin._wanStatus.wlan0.active).to.be.true;
      expect(plugin._wanStatus.wlan1.active).to.be.false;
    });

    it('repeats a load_balance apply without bakIntfs with the same commands', async() => {
      const {plugin} = setup({type: 'load_balance', nextHops: [{viaIntf: 'eth0', weight: 50}, {viaIntf: 'eth1', weight: 50}]},
        [{name: 'eth0'}, {name: 'eth1', ready: false}]);
      await plugin.apply();
      await plugin.apply();
      await plugin.apply();
      expect(stub.calls).to.deep.equal([].concat(GOLDEN.lb_apply, GOLDEN.lb_apply, GOLDEN.lb_apply));
      expect(plugin._dnsRoutes.eth0.length).to.be.equal(2);
    });

    it('removes the cached DNS routes in main before a repeated single WAN apply re-adds them', async() => {
      const {plugin} = setup({type: 'single', viaIntf: 'eth0'}, [{name: 'eth0'}]);
      await plugin.apply();
      stub.calls.length = 0;
      await plugin.apply();
      const del = at('sudo ip -4 route del unicast 10.0.1.53 via 10.0.1.1 dev eth0 table main');
      expect(del).to.be.above(-1);
      expect(at('sudo ip -4 route add unicast 10.0.1.53 via 10.0.1.1 dev eth0 table main')).to.be.above(del);
      expect(plugin._dnsRoutes.eth0.length).to.be.equal(2);
    });
  });

  describe('load_balance backup WAN_CONN_CHECK', function() {
    it('only publishes when a standby backup goes down or comes back', async() => {
      const {plugin, intfs} = setup(LB_BACKUP, [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0'}]);
      await plugin.apply();
      intfs.wlan0.o.ready = false;
      connCheck(plugin, 'wlan0');
      intfs.wlan0.o.ready = true;
      connCheck(plugin, 'wlan0');
      await settle();
      expect(plugin.scheduled).to.be.empty;
      expect(plugin.published.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['wlan0', false, false], ['wlan0', true, false]]);
      expect(plugin.published[0].currentStatus.wlan0.backup).to.be.true;
      expect(plugin.published[0].currentStatus.eth0.backup).to.be.undefined;
    });

    it('schedules an apply when a backup comes back and nothing is active', async() => {
      const {plugin, intfs} = setup(LB_BACKUP, [{name: 'eth0', ready: false}, {name: 'eth1', ready: false}, {name: 'wlan0', ready: false}]);
      await plugin.apply();
      intfs.wlan0.o.ready = true;
      connCheck(plugin, 'wlan0');
      expect(plugin.scheduled.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['wlan0', true, true]]);
    });

    it('schedules an apply when the active backup goes down', async() => {
      const {plugin, intfs} = setup(LB_BACKUP, [{name: 'eth0', ready: false}, {name: 'eth1', ready: false}, {name: 'wlan0'}]);
      await plugin.apply();
      intfs.wlan0.o.ready = false;
      connCheck(plugin, 'wlan0');
      expect(plugin.scheduled.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['wlan0', false, true]]);
    });

    it('schedules an apply when a nextHop comes back while a backup is active', async() => {
      const {plugin, intfs} = setup(LB_BACKUP, [{name: 'eth0', ready: false}, {name: 'eth1', ready: false}, {name: 'wlan0'}]);
      await plugin.apply();
      intfs.eth1.o.ready = true;
      connCheck(plugin, 'eth1');
      expect(plugin.scheduled.map(d => [d.intf, d.ready, d.wanSwitched])).to.deep.equal([['eth1', true, true]]);
    });

    it('fails back to a higher ranked backup only with failback', async() => {
      for (const failback of [true, false]) {
        const {plugin, intfs} = setup(Object.assign({}, LB_TWO_BACKUPS, {failback}), [{name: 'eth0', ready: false}, {name: 'eth1', ready: false},
          {name: 'wlan0', ready: false}, {name: 'wlan1'}]);
        await plugin.apply();
        intfs.wlan0.o.ready = true;
        connCheck(plugin, 'wlan0');
        expect(plugin.scheduled.length).to.be.equal(failback ? 1 : 0);
      }
    });
  });

  describe('load_balance backup address changes', function() {
    async function standby() {
      const ctx = setup(LB_BACKUP, [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0'}]);
      await ctx.plugin.apply();
      stub.calls.length = 0;
      return ctx;
    }

    it('updates only the standby backup routes on an IPv4 change', async() => {
      const {plugin} = await standby();
      plugin.onEvent(event.buildEvent(event.EVENT_IP_CHANGE, {intf: 'wlan0'}));
      await settle();
      expect(reapplies).to.be.equal(0);
      expect(stub.calls.filter(c => /route flush table \S+$/.test(c))).to.be.empty;
      const routeCmds = stub.calls.filter(c => c.includes(' route ') || c.includes(' r show '));
      expect(routeCmds.filter(c => !c.includes('wlan0'))).to.be.empty;
      expect(stub.calls).to.include('sudo ip -4 route flush table global_default dev wlan0');
      expect(stub.calls).to.include('sudo ip -4 route add unicast default via 10.0.3.1 dev wlan0 table main preference 3');
      expect(stub.matching('10.0.3.53')).to.be.empty;
      expect(stub.calls).to.include('sudo iptables -w -t nat -F FR_OUTPUT_SNAT');
    });

    it('keeps a ready standby backup below the active lower ranked backup on an IPv4 change', async() => {
      const {plugin, intfs} = setup(Object.assign({}, LB_TWO_BACKUPS, {failback: false}), [{name: 'eth0', ready: false}, {name: 'eth1', ready: false},
        {name: 'wlan0', ready: false}, {name: 'wlan1'}]);
      await plugin.apply();
      expect(plugin._wanStatus.wlan1.active).to.be.true;
      intfs.wlan0.o.ready = true;
      plugin._wanStatus.wlan0.ready = true;
      stub.calls.length = 0;
      plugin.onEvent(event.buildEvent(event.EVENT_IP_CHANGE, {intf: 'wlan0'}));
      await settle();
      expect(reapplies).to.be.equal(0);
      // wlan1 is active at metric 4, wlan0 stays at its unready metric behind it
      expect(stub.calls).to.include('sudo ip -4 route add unicast default via 10.0.3.1 dev wlan0 table main preference 103');
      expect(stub.matching('dev wlan0 table main preference 3')).to.be.empty;
      expect(stub.calls.filter(c => (c.includes(' route ') || c.includes(' r show ')) && !c.includes('wlan0'))).to.be.empty;
    });

    it('adds no IPv6 route for the standby backup on an IPv6 change', async() => {
      const {plugin} = await standby();
      plugin.onEvent(event.buildEvent(event.EVENT_IP6_CHANGE, {intf: 'wlan0'}));
      await settle();
      expect(stub.calls.filter(c => /route flush table \S+$/.test(c))).to.be.empty;
      expect(stub.calls.filter(c => (c.includes(' route ') || c.includes(' r show ')) && !c.includes('wlan0'))).to.be.empty;
      expect(stub.matching('route add')).to.be.empty;
      expect(stub.matching('route replace')).to.be.empty;
    });

    it('re-applies as before on an address change of the active backup or a nextHop', async() => {
      const {plugin} = await standby();
      plugin.onEvent(event.buildEvent(event.EVENT_IP_CHANGE, {intf: 'eth0'}));
      expect(reapplies).to.be.equal(1);
      plugin._wanStatus.wlan0.active = true;
      plugin.onEvent(event.buildEvent(event.EVENT_IP_CHANGE, {intf: 'wlan0'}));
      expect(reapplies).to.be.equal(2);
      plugin.onEvent(event.buildEvent(event.EVENT_IP6_CHANGE, {intf: 'wlan0'}));
      await settle();
      expect(stub.calls).to.include('sudo ip -6 route flush table global_default');
    });
  });

  describe('backup flag on the wire', function() {
    it('marks only backups in the conn states', async() => {
      const {plugin} = setup(LB_BACKUP, [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0'}]);
      await plugin.apply();
      const states = plugin.getWANConnStates();
      expect(states.wlan0.backup).to.be.true;
      expect(states.eth0).to.not.have.property('backup');
      expect(plugin.getWANConnState('wlan0').backup).to.be.true;
      expect(plugin.getWANConnState('eth0')).to.not.have.property('backup');
      const enriched = await plugin.enrichWanStatus(states);
      expect(enriched.wlan0.backup).to.be.true;
      expect(enriched.eth1).to.not.have.property('backup');
    });

    it('passes the flag to the interface wanConnState', async() => {
      const {plugin} = setup(LB_BACKUP, [{name: 'eth0'}, {name: 'eth1'}, {name: 'wlan0'}]);
      await plugin.apply();
      const InterfaceBasePlugin = stub.load(require.resolve('../../plugins/interface/intf_base_plugin.js'));
      delete require.cache[routingPath];
      pl.getPluginInstance = (category, name) => category === 'routing' && name === 'global' ? plugin : undefined;
      const wlan0 = new InterfaceBasePlugin('wlan0');
      wlan0._wanConnState = {ready: true};
      expect(wlan0.getWANConnState()).to.include({ready: true, active: false, inUse: false, backup: true});
      expect(new InterfaceBasePlugin('eth0').getWANConnState()).to.not.have.property('backup');
    });
  });
});
