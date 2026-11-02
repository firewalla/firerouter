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

let chai = require('chai');
let expect = chai.expect;

const stub = require('./stub_exec.js');
const BondInterfacePlugin = stub.load(require.resolve('../../plugins/interface/bond_intf_plugin.js'));

describe('Test bond interface plugin', function(){
  this.timeout(30000);

  beforeEach(() => stub.reset());

  describe('mode', function(){
    // mode is interpolated into `ip link add <name> type bond mode <mode>`, so it is held to the
    // list of modes the driver documents. an empty intf array keeps the lower interface lookup out
    // of the way, it is not what these cases are about
    it('should fall back to the default for an unsupported mode', async()=> {
      const plugin = stub.build(BondInterfacePlugin, "bond0",
        {intf: [], mode: "balance-rr; touch /tmp/pwn; #", enabled: true});
      await plugin.createInterface().catch(() => {});
      expect(stub.matching("touch /tmp/pwn").length).to.be.equal(0);
      const addCmd = stub.calls.find(c => c.includes("type bond"));
      expect(addCmd).to.contain("mode balance-rr");
    });

    it('should pass through a documented mode', async()=> {
      const plugin = stub.build(BondInterfacePlugin, "bond0", {intf: [], mode: "802.3ad", enabled: true});
      await plugin.createInterface().catch(() => {});
      const addCmd = stub.calls.find(c => c.includes("type bond"));
      expect(addCmd).to.contain("mode 802.3ad");
    });
  });

  describe('adSelect', function(){
    const pl = require('../../plugins/plugin_loader.js');
    const origGetPluginInstance = pl.getPluginInstance;
    // two present member ports, so the detach / re-enslave ordering is exercised
    const member = { isInterfacePresent: async () => true };

    beforeEach(() => {
      pl.getPluginInstance = () => member;
    });
    afterEach(() => {
      pl.getPluginInstance = origGetPluginInstance;
    });

    // current is what /sys/class/net/bond0/bonding/ad_select reads, null when it can't be read
    function build(extra, current = null) {
      const plugin = stub.build(BondInterfacePlugin, "bond0",
        Object.assign({intf: ["eth1", "eth2"], mode: "802.3ad", enabled: true}, extra));
      plugin.subscribeChangeFrom = () => {};
      plugin._getSysFSClassNetValueOf = async (intf, key) => (intf === "bond0" && key === "bonding/ad_select") ? current : null;
      return plugin;
    }

    function expectSetInOrder(value) {
      const addIdx = stub.calls.indexOf("sudo ip link add bond0 type bond mode 802.3ad");
      const detachIdx = stub.calls.indexOf("sudo ifenslave -d bond0 eth1 eth2");
      const downIdx = stub.calls.indexOf("sudo ip link set dev bond0 down");
      const selIdx = stub.calls.indexOf(`sudo ip link set dev bond0 type bond ad_select ${value}`);
      const enslaveIdx = stub.calls.indexOf("sudo ifenslave bond0 eth1 eth2");
      expect(addIdx).to.be.at.least(0);
      expect(detachIdx).to.be.above(addIdx);
      expect(downIdx).to.be.above(detachIdx);
      expect(selIdx).to.be.above(downIdx);
      expect(enslaveIdx).to.be.above(selIdx);
    }

    it('should not touch ad_select when the field is absent', async()=> {
      await build({}).createInterface();
      expect(stub.matching("ad_select").length).to.be.equal(0);
      expect(stub.calls.indexOf("sudo ip link set dev bond0 down")).to.be.equal(-1);
    });

    it('should set ad_select while the bond is down and its members are detached', async()=> {
      await build({adSelect: "bandwidth"}, "stable 0").createInterface();
      expectSetInOrder("bandwidth");
    });

    it('should not bring the bond down when it already has the configured value', async()=> {
      await build({adSelect: "bandwidth"}, "bandwidth 1").createInterface();
      expect(stub.matching("ad_select").length).to.be.equal(0);
      expect(stub.calls.indexOf("sudo ip link set dev bond0 down")).to.be.equal(-1);
      expect(stub.calls).to.include("sudo ifenslave bond0 eth1 eth2");
    });

    it('should set ad_select when the current value cannot be read', async()=> {
      await build({adSelect: "bandwidth"}, null).createInterface();
      expectSetInOrder("bandwidth");
    });

    it('should log and still re-enslave the members when setting ad_select fails', async()=> {
      stub.failOn("ad_select");
      const plugin = build({adSelect: "bandwidth"}, "stable 0");
      const errors = [];
      plugin.log = Object.assign(Object.create(plugin.log), {error: (...args) => errors.push(args.join(" "))});
      await plugin.createInterface();
      expectSetInOrder("bandwidth");
      expect(errors.some(e => e.includes("Failed to set ad_select bandwidth on bond bond0"))).to.be.true;
    });

    it('should fall back to stable for an unsupported value', async()=> {
      const plugin = build({adSelect: "bandwidth; touch /tmp/pwn; #"}, "bandwidth 1");
      const errors = [];
      plugin.log = Object.assign(Object.create(plugin.log), {error: (...args) => errors.push(args.join(" "))});
      await plugin.createInterface();
      expect(stub.matching("touch /tmp/pwn").length).to.be.equal(0);
      expect(stub.calls).to.include("sudo ip link set dev bond0 type bond ad_select stable");
      expect(errors.some(e => e.includes("Unsupported bond adSelect for bond0, using stable"))).to.be.true;
    });

    it('should ignore the field for modes other than 802.3ad', async()=> {
      await build({mode: "balance-rr", adSelect: "bandwidth"}).createInterface();
      expect(stub.matching("ad_select").length).to.be.equal(0);
    });
  });
});
