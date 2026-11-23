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

  describe('port state reads', function(){
    const { BridgePortStateSync } = BridgeInterfacePlugin;
    const origReadFile = fsp.readFile;
    const origReaddir = fsp.readdir;
    const origReadlink = fsp.readlink;
    // /sys/class/net/<bridge>/brif/<port>/state contents by "<bridge>/<port>", a missing key fails the read
    let states;

    beforeEach(() => {
      states = {};
      fsp.readFile = async (file) => {
        const m = file.match(/^\/sys\/class\/net\/([^/]+)\/brif\/([^/]+)\/state$/);
        const raw = m && states[`${m[1]}/${m[2]}`];
        if (raw === undefined)
          throw new Error(`ENOENT: ${file}`);
        return raw;
      };
    });
    afterEach(() => {
      fsp.readFile = origReadFile;
      fsp.readdir = origReaddir;
      fsp.readlink = origReadlink;
    });

    describe('readBrifState', function(){
      it('should return the state number', async()=> {
        states["br0/eth1"] = "3\n";
        expect(await BridgePortStateSync.readBrifState("br0", "eth1")).to.be.equal(3);
        states["br0/eth1"] = "0\n";
        expect(await BridgePortStateSync.readBrifState("br0", "eth1")).to.be.equal(0);
      });

      it('should return undefined when the read fails', async()=> {
        expect(await BridgePortStateSync.readBrifState("br0", "eth9")).to.be.equal(undefined);
      });
    });

    describe('getNativeBridgePortState', function(){
      beforeEach(() => {
        fsp.readlink = async (file) => file === "/sys/class/net/eth1/master" ? "../br0" : (() => { throw new Error("ENOENT"); })();
      });

      it('should read the state through the native bridge', async()=> {
        states["br0/eth1"] = "4\n";
        expect(await BridgePortStateSync.getNativeBridgePortState("eth1")).to.be.equal(4);
      });

      it('should return null without a native bridge', async()=> {
        expect(await BridgePortStateSync.getNativeBridgePortState("eth2")).to.be.equal(null);
      });

      it('should return undefined when the state cannot be read', async()=> {
        expect(await BridgePortStateSync.getNativeBridgePortState("eth1")).to.be.equal(undefined);
      });
    });

    describe('applyVlanPortStates', function(){
      beforeEach(() => {
        fsp.readdir = async () => ["eth0", "eth1", "eth1.10", "eth2.10"];
        fsp.readlink = async () => "../br1";
      });

      it('should skip a vlan port already at the target state', async()=> {
        states["br1/eth1.10"] = "3\n";
        await BridgePortStateSync.applyVlanPortStates("eth1", 3);
        expect(stub.matching("bridge link set")).to.be.deep.equal([]);
      });

      it('should set forwarding when the vlan port differs', async()=> {
        states["br1/eth1.10"] = "0\n";
        await BridgePortStateSync.applyVlanPortStates("eth1", 3);
        expect(stub.matching("bridge link set")).to.be.deep.equal(["sudo bridge link set dev eth1.10 state forwarding"]);
      });

      it('should collapse every other state to disabled', async()=> {
        for (const stpState of [1, 2, 4]) {
          stub.reset();
          states["br1/eth1.10"] = "3\n";
          await BridgePortStateSync.applyVlanPortStates("eth1", stpState);
          expect(stub.matching("bridge link set")).to.be.deep.equal(["sudo bridge link set dev eth1.10 state disabled"]);
        }
      });

      it('should skip a disabled vlan port when the target is disabled', async()=> {
        states["br1/eth1.10"] = "0\n";
        await BridgePortStateSync.applyVlanPortStates("eth1", 4);
        expect(stub.matching("bridge link set")).to.be.deep.equal([]);
      });

      it('should set the state when the vlan port state cannot be read', async()=> {
        await BridgePortStateSync.applyVlanPortStates("eth1", 3);
        expect(stub.matching("bridge link set")).to.be.deep.equal(["sudo bridge link set dev eth1.10 state forwarding"]);
      });
    });
  });
});
