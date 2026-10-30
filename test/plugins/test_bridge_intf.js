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
const BridgeInterfacePlugin = stub.load(require.resolve('../../plugins/interface/bridge_intf_plugin.js'));
const pl = require('../../plugins/plugin_loader.js');
const fsp = require('fs').promises;

describe('Test bridge interface plugin', function(){
  this.timeout(30000);

  beforeEach(() => stub.reset());

  describe('stp port status', function(){
    it('should read the port status through mstpctl showportdetail', async()=> {
      const plugin = stub.build(BridgeInterfacePlugin, "br0", {intf: ["eth1", "eth2"], enabled: true});
      await plugin.getStpPortStatus();
      const cmds = stub.matching("mstpctl");
      expect(cmds.length).to.be.equal(1);
      expect(cmds[0]).to.match(/^sudo \S+\/mstpctl showportdetail br0$/);
    });
  });

  describe('stp apply', function(){
    const origGetPluginInstance = pl.getPluginInstance;
    const origReaddir = fsp.readdir;
    const member = { isInterfacePresent: async () => true };

    beforeEach(() => {
      pl.getPluginInstance = () => member;
      fsp.readdir = async () => [];
    });
    afterEach(() => {
      pl.getPluginInstance = origGetPluginInstance;
      fsp.readdir = origReaddir;
    });

    // stpState is what /sys/class/net/br0/bridge/stp_state reads, null when it can't be read
    function build(extra, stpState = null) {
      const plugin = stub.build(BridgeInterfacePlugin, "br0",
        Object.assign({intf: ["eth1", "eth2"], enabled: true}, extra));
      plugin.subscribeChangeFrom = () => {};
      plugin._getSysFSClassNetValueOf = async (intf, key) => (intf === "br0" && key === "bridge/stp_state") ? stpState : null;
      plugin._stateSync = { startMonitor: async () => {}, stopMonitor: async () => {}, syncInitialPortStates: async () => {} };
      return plugin;
    }

    describe('running bridge', function(){
      it('should not toggle stp when mstpd runs the bridge', async()=> {
        stub.outputFor("showbridge br0 enabled", "yes\n");
        expect(await build({}, "2").createInterface()).to.be.equal(true);
        expect(stub.matching("brctl stp br0")).to.be.deep.equal([]);
      });

      it('should toggle stp off then on when mstpd has the bridge disabled', async()=> {
        stub.outputFor("showbridge br0 enabled", "no\n");
        await build({}, "2").createInterface();
        expect(stub.matching("brctl stp br0")).to.be.deep.equal(["sudo brctl stp br0 off", "sudo brctl stp br0 on"]);
      });

      it('should toggle stp off then on for kernel stp', async()=> {
        await build({}, "1").createInterface();
        expect(stub.matching("brctl stp br0")).to.be.deep.equal(["sudo brctl stp br0 off", "sudo brctl stp br0 on"]);
        expect(stub.matching("showbridge")).to.be.deep.equal([]);
      });

      it('should toggle stp when the state cannot be read', async()=> {
        await build({}, null).createInterface();
        expect(stub.matching("brctl stp br0")).to.be.deep.equal(["sudo brctl stp br0 off", "sudo brctl stp br0 on"]);
      });

      it('should toggle stp when showbridge fails', async()=> {
        stub.failOn("showbridge");
        await build({}, "2").createInterface();
        expect(stub.matching("brctl stp br0")).to.be.deep.equal(["sudo brctl stp br0 off", "sudo brctl stp br0 on"]);
      });
    });

    describe('priority', function(){
      const setter = "mstpctl settreeprio br0 0 0";

      it('should set priority 0 after stp is turned on', async()=> {
        await build({}, "1").createInterface();
        const on = stub.calls.indexOf("sudo brctl stp br0 on");
        const prio = stub.calls.findIndex(c => c.endsWith(setter));
        expect(on).to.be.at.least(0);
        expect(prio).to.be.above(on);
      });

      it('should set priority 0 when the toggle is skipped', async()=> {
        stub.outputFor("showbridge br0 enabled", "yes\n");
        await build({}, "2").createInterface();
        expect(stub.matching(setter).length).to.be.equal(1);
      });

      it('should not set priority when stp is disabled', async()=> {
        await build({stp: false}).createInterface();
        expect(stub.matching("settreeprio")).to.be.deep.equal([]);
      });

      it('should not set priority on a single member bridge', async()=> {
        await build({intf: ["eth1"]}).createInterface();
        expect(stub.matching("settreeprio")).to.be.deep.equal([]);
      });

      it('should not set priority on a vlan bridge', async()=> {
        await build({intf: ["eth1.10", "eth2.10"]}).createInterface();
        expect(stub.matching("settreeprio")).to.be.deep.equal([]);
      });

      it('should still apply when the setter fails', async()=> {
        stub.failOn("settreeprio");
        expect(await build({}, "1").createInterface()).to.be.equal(true);
        expect(stub.matching("settreeprio").length).to.be.equal(1);
        expect(stub.matching("ip link set dev br0 up").length).to.be.equal(1);
      });
    });
  });
});
