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
    pl.scheduleReapply = () => {};
  });

  after(() => {
    pl.getPluginInstance = origGetPluginInstance;
    pl.scheduleReapply = origScheduleReapply;
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
});
