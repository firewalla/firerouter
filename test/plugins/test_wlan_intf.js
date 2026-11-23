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

// Off-box suite for the wlan interface plugin: the wpa_cli commands it issues, recorded instead of run.

const chai = require('chai');
const expect = chai.expect;

const stub = require('./stub_exec.js');
// util/routing.js captures exec when it is required, so load it again under the stub with the
// routing plugin, then drop it so the suites that run later get the real one
const routingPath = require.resolve('../../util/routing.js');
delete require.cache[routingPath];
const WLANInterfacePlugin = stub.load(require.resolve('../../plugins/interface/wlan_intf_plugin.js'));
const RoutingPlugin = stub.load(require.resolve('../../plugins/routing/routing_plugin.js'));
delete require.cache[routingPath];
const pl = require('../../plugins/plugin_loader.js');
const event = require('../../core/event.js');

const origGetPluginInstance = pl.getPluginInstance;

const STATUS = '-i wlan0 status';
const SCAN = '-i wlan0 scan';

// the scans a plugin issued, with the control socket they went to
const scans = () => stub.matching(SCAN);

function wlanWan(ready) {
  const plugin = stub.build(WLANInterfacePlugin, 'wlan0', {meta: {type: 'wan'}, enabled: true, wpaSupplicant: {}});
  plugin._wanConnState = {ready, successCount: 0, failureCount: 0};
  return plugin;
}

// the other WANs the global routing plugin lists, besides the wlan one
function routingWith(wans) {
  return {getAllWANPlugins: () => wans.map(ready => ({isReady: () => ready}))};
}

function installRouting(routing) {
  pl.getPluginInstance = (category, name) => category === 'routing' && name === 'global' ? routing : undefined;
}

function wanCheck(plugin, active) {
  plugin.onEvent(event.buildEvent(event.EVENT_WAN_CONN_CHECK, {intf: plugin.name, active, failures: []}));
}

// the event handler fires onWanCheckFailed and does not wait for it, keep its promises to wait on them
function trackHook(plugin) {
  const started = [];
  const hook = plugin.onWanCheckFailed;
  plugin.onWanCheckFailed = function() {
    const p = hook.apply(this, arguments);
    started.push(p);
    return p;
  };
  return () => Promise.allSettled(started);
}

describe('Test wlan interface plugin', function() {
  this.timeout(30000);

  beforeEach(() => {
    stub.reset();
    stub.outputFor(STATUS, 'wpa_state=DISCONNECTED\n');
    stub.outputFor(SCAN, 'OK\n');
    installRouting(routingWith([false]));
  });

  after(() => {
    pl.getPluginInstance = origGetPluginInstance;
  });

  describe('execWpaCli', () => {
    it('should build the wpa_cli command from the interface, the control directory and the arguments', async() => {
      await WLANInterfacePlugin.execWpaCli('wlan0', '/run/ctl/wlan0', ['set_network', '0', 'ssid', 'two words']);
      // the platform may run its own commands to find the wpa_cli binary
      const wpaCli = stub.matching(' -i wlan0 ');
      expect(wpaCli.length).to.equal(1);
      expect(wpaCli[0]).to.match(/^sudo \S*wpa_cli -p \/run\/ctl\/wlan0 -i wlan0 set_network 0 ssid two words$/);
    });

    it('should read the status of a wan from its wpa_supplicant control socket', async() => {
      const status = await wlanWan(false).getWpaStatus();
      expect(status.wpa_state).to.equal('DISCONNECTED');
      expect(stub.matching(STATUS)[0]).to.match(/ -p \S+\/wpa_supplicant\/wlan0 -i wlan0 status$/);
    });
  });

  describe('scan while no WAN is ready', () => {
    it('should scan on its own control socket', async() => {
      await wlanWan(false).onWanCheckFailed();
      expect(scans().length).to.equal(1);
      expect(scans()[0]).to.match(/^sudo \S*wpa_cli -p \S+\/wpa_supplicant\/wlan0 -i wlan0 scan$/);
    });

    // after "stopping automatic scanning" the wpa_supplicant of an Orange stays in SCANNING
    for (const state of ['SCANNING', 'DISCONNECTED', 'INACTIVE', 'INTERFACE_DISABLED']) {
      it(`should scan in wpa_state ${state}`, async() => {
        stub.outputFor(STATUS, `wpa_state=${state}\n`);
        await wlanWan(false).onWanCheckFailed();
        expect(scans().length).to.equal(1);
      });
    }

    it('should scan when wpa_state cannot be read', async() => {
      stub.failOn(STATUS);
      await wlanWan(false).onWanCheckFailed();
      expect(scans().length).to.equal(1);
    });

    for (const state of ['COMPLETED', 'AUTHENTICATING', 'ASSOCIATING', 'ASSOCIATED', '4WAY_HANDSHAKE', 'GROUP_HANDSHAKE']) {
      it(`should not scan in wpa_state ${state}`, async() => {
        stub.outputFor(STATUS, `wpa_state=${state}\n`);
        await wlanWan(false).onWanCheckFailed();
        expect(stub.matching(STATUS).length).to.equal(1);
        expect(scans()).to.deep.equal([]);
      });
    }

    it('should neither call wpa_cli nor log an error for a wan without a wpaSupplicant block', async() => {
      const plugin = wlanWan(false);
      delete plugin.networkConfig.wpaSupplicant;
      const errors = [];
      plugin.log = {info: () => {}, warn: () => {}, debug: () => {}, error: (...args) => errors.push(args)};
      await plugin.onWanCheckFailed();
      expect(stub.calls).to.deep.equal([]);
      expect(errors).to.deep.equal([]);
    });

    it('should scan when wpaSupplicant is an empty object, it counts as configured', async() => {
      const plugin = wlanWan(false);
      expect(plugin.networkConfig.wpaSupplicant).to.deep.equal({});
      await plugin.onWanCheckFailed();
      expect(scans().length).to.equal(1);
    });

    it('should not scan when the wlan wan itself is ready', async() => {
      await wlanWan(true).onWanCheckFailed();
      expect(stub.calls).to.deep.equal([]);
    });

    it('should not scan while another wan is ready', async() => {
      installRouting(routingWith([false, true]));
      await wlanWan(false).onWanCheckFailed();
      expect(stub.calls).to.deep.equal([]);
    });

    it('should scan when the routing plugin is not there yet', async() => {
      installRouting(undefined);
      await wlanWan(false).onWanCheckFailed();
      expect(scans().length).to.equal(1);
    });

    it('should scan when the routing plugin has no wan list yet', async() => {
      installRouting({getAllWANPlugins: () => null});
      await wlanWan(false).onWanCheckFailed();
      expect(scans().length).to.equal(1);
    });

    it('should scan at most once a minute', async() => {
      const plugin = wlanWan(false);
      await plugin.onWanCheckFailed();
      await plugin.onWanCheckFailed();
      expect(scans().length).to.equal(1);
      expect(stub.matching(STATUS).length).to.equal(1);

      plugin._lastWpaScanTs -= 59 * 1000;
      await plugin.onWanCheckFailed();
      expect(scans().length).to.equal(1);

      plugin._lastWpaScanTs -= 2 * 1000;
      await plugin.onWanCheckFailed();
      expect(scans().length).to.equal(2);
    });

    it('should claim the minute before it reads wpa_state', async() => {
      const plugin = wlanWan(false);
      await Promise.all([plugin.onWanCheckFailed(), plugin.onWanCheckFailed(), plugin.onWanCheckFailed()]);
      expect(scans().length).to.equal(1);
    });

    it('should not read wpa_state again within the minute after a skip', async() => {
      stub.outputFor(STATUS, 'wpa_state=COMPLETED\n');
      const plugin = wlanWan(false);
      await plugin.onWanCheckFailed();
      await plugin.onWanCheckFailed();
      expect(stub.matching(STATUS).length).to.equal(1);
    });

    it('should reject when the scan fails, and scan again a minute later', async() => {
      stub.failOn(SCAN);
      const plugin = wlanWan(false);
      let error = null;
      await plugin.onWanCheckFailed().catch(err => { error = err; });
      expect(error).to.be.an('error');

      stub.reset();
      stub.outputFor(STATUS, 'wpa_state=SCANNING\n');
      plugin._lastWpaScanTs -= 61 * 1000;
      await plugin.onWanCheckFailed();
      expect(scans().length).to.equal(1);
    });
  });

  describe('wan connectivity check events', () => {
    function freshWan() {
      const plugin = wlanWan(true);
      plugin._wanConnState = {ready: true, successCount: 4, failureCount: 0};
      plugin.publishWANStateChange = async () => {};
      plugin.hooksDone = trackHook(plugin);
      return plugin;
    }

    it('should scan once the wan is not ready, not on the first failed check', async() => {
      const plugin = freshWan();
      wanCheck(plugin, false);
      await plugin.hooksDone();
      expect(plugin.isReady()).to.equal(true);
      expect(scans()).to.deep.equal([]);

      wanCheck(plugin, false);
      await plugin.hooksDone();
      expect(plugin.isReady()).to.equal(false);
      expect(scans().length).to.equal(1);
    });

    it('should not scan after a successful check', async() => {
      const plugin = freshWan();
      wanCheck(plugin, true);
      await plugin.hooksDone();
      expect(stub.calls).to.deep.equal([]);
    });

    it('should not throw out of the event handler when the scan fails', async() => {
      stub.failOn(SCAN);
      const plugin = freshWan();
      wanCheck(plugin, false);
      wanCheck(plugin, false);
      await plugin.hooksDone();
      expect(scans().length).to.equal(1);
    });

    it('should leave the other wan types alone', async() => {
      const InterfaceBasePlugin = Object.getPrototypeOf(WLANInterfacePlugin);
      const plugin = stub.build(InterfaceBasePlugin, 'eth0', {meta: {type: 'wan'}, enabled: true});
      plugin._wanConnState = {ready: true, successCount: 4, failureCount: 0};
      plugin.publishWANStateChange = async () => {};
      const hooksDone = trackHook(plugin);
      wanCheck(plugin, false);
      wanCheck(plugin, false);
      await hooksDone();
      expect(plugin.isReady()).to.equal(false);
      expect(stub.calls).to.deep.equal([]);
    });
  });

  // routing type single is the default when default.type is absent. a failed check clears ready there but
  // never the active flag, so the scan cannot wait for the active list to empty
  describe('single routing mode, the wlan wan is the only wan', () => {
    it('should scan after failed checks went through the interface and the routing handlers', async() => {
      const wlan = wlanWan(true);
      wlan._wanConnState = {ready: true, successCount: 4, failureCount: 0};
      wlan.publishWANStateChange = async () => {};
      const hooksDone = trackHook(wlan);

      const routing = stub.build(RoutingPlugin, 'global', {default: {}});
      routing.init({});
      routing.processWANConnChange = async () => {};
      routing.enrichWanStatus = async () => null;
      routing.scheduleApplyActiveGlobalDefaultRouting = () => {};
      routing._wanStatus = {wlan0: {seq: 0, ready: true, active: true, inUse: true, plugin: wlan}};
      pl.getPluginInstance = (category, name) => {
        if (category === 'interface' && name === 'wlan0')
          return wlan;
        if (category === 'routing' && name === 'global')
          return routing;
      };

      // the loader hands an event to the interface plugins first, then to the routing plugin
      const deliver = (active) => {
        const e = event.buildEvent(event.EVENT_WAN_CONN_CHECK, {intf: 'wlan0', active, failures: []});
        wlan.onEvent(e);
        routing.onEvent(e);
      };

      deliver(false);
      await hooksDone();
      expect(scans()).to.deep.equal([]);

      deliver(false);
      await hooksDone();
      expect(routing._wanStatus.wlan0.ready).to.equal(false);
      expect(scans().length).to.equal(1);
    });
  });
});
