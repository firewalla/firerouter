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

  describe('port state events', function(){
    const { BridgePortStateSync } = BridgeInterfacePlugin;
    const era = require('../../event/EventRequestApi.js');
    const origAddStateEvent = era.addStateEvent;
    // addStateEvent arguments: [state_type, state_key, state_value, labels, ts]
    let events, logs;

    // `bridge monitor link` lines of a member port, in the common format and in the one with the
    // extra "state <ADMIN-STATE>" token after the ifname (iproute2 on gold)
    const line = (port, state, master = "br0") =>
      `4: ${port}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 master ${master} state ${state} priority 32 cost 4`;
    const goldLine = (port, state) =>
      `4: ${port} state UP : <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 master br0 state ${state} priority 32 cost 4`;

    beforeEach(() => {
      events = [];
      logs = {info: [], warn: []};
      era.addStateEvent = async (...args) => { events.push(args); };
    });
    afterEach(() => {
      era.addStateEvent = origAddStateEvent;
    });

    function newSync() {
      const log = {info: m => logs.info.push(m), warn: m => logs.warn.push(m), debug: () => {}};
      const sync = new BridgePortStateSync("br0", log);
      sync.applied = [];
      sync._scheduleApply = (port, stateNum) => sync.applied.push([port, stateNum]);
      return sync;
    }

    function feed(sync, ...lines) {
      for (const l of lines)
        sync._handleLine(l);
    }

    const common = {bridge: "br0", port: "eth2", ok_value: 0, no_error: 1};

    describe('mapping', function(){
      // kernel state name -> [state name, state_value]
      const table = {
        forwarding: ["forwarding", 0],
        learning: ["learning", 1],
        blocking: ["discarding", 2],
        listening: ["discarding", 2],
        disabled: ["disabled", 3],
      };
      for (const kernel of Object.keys(table)) {
        it(`should publish kernel ${kernel} as ${table[kernel][0]} (${table[kernel][1]})`, ()=> {
          const [name, value] = table[kernel];
          const sync = newSync();
          // an old state that differs from the new one in both name and value
          const old = name === "forwarding" ? "disabled" : "forwarding";
          sync._lastStates.set("eth2", old);
          feed(sync, line("eth2", kernel));
          expect(events.length).to.be.equal(1);
          expect(events[0].slice(0, 3)).to.be.deep.equal(["bridge_port_stp_state", "eth2", value]);
          expect(events[0][3]).to.be.deep.equal(Object.assign({current_state: name, last_state: old}, common));
        });
      }
    });

    describe('first sighting and change', function(){
      it('should publish a port seen for the first time as its initial state', ()=> {
        const sync = newSync();
        feed(sync, line("eth2", "forwarding"));
        expect(events.length).to.be.equal(1);
        expect(events[0].slice(0, 3)).to.be.deep.equal(["bridge_port_stp_state", "eth2", 0]);
        expect(events[0][3]).to.be.deep.equal(Object.assign({current_state: "forwarding", last_state: null}, common));
        expect(logs.info).to.be.deep.equal(["bridge port br0:eth2 forwarding (kernel forwarding)"]);
        // the change behind it is one message that names the state it came from
        feed(sync, line("eth2", "blocking"));
        expect(events.length).to.be.equal(2);
        expect(events[1][3]).to.be.deep.equal(Object.assign({current_state: "discarding", last_state: "forwarding"}, common));
      });

      it('should publish a change as one message', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        feed(sync, line("eth2", "blocking"));
        expect(events.length).to.be.equal(1);
        expect(events[0][3]).to.be.deep.equal(Object.assign({current_state: "discarding", last_state: "forwarding"}, common));
      });

      it('should log the kernel word once per change', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        feed(sync, line("eth2", "listening"), line("eth2", "blocking"));
        expect(logs.info).to.be.deep.equal(["bridge port br0:eth2 forwarding -> discarding (kernel listening)"]);
      });
    });

    describe('lines that publish nothing', function(){
      it('should ignore a line with the state the port already has', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        feed(sync, line("eth2", "forwarding"), line("eth2", "forwarding"));
        expect(events).to.be.deep.equal([]);
      });

      it('should ignore listening after blocking, both being discarding', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        feed(sync, line("eth2", "blocking"), line("eth2", "listening"));
        expect(events.length).to.be.equal(1);
      });

      it('should ignore a port of another bridge', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        feed(sync, line("eth2", "blocking", "br1"), line("eth2.10", "blocking", "br1"));
        expect(events).to.be.deep.equal([]);
        expect(sync._lastStates.get("eth2")).to.be.equal("forwarding");
      });

      it('should ignore a line without a state', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        feed(sync, "4: eth2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 master br0 priority 32 cost 4");
        expect(events).to.be.deep.equal([]);
      });

      it('should ignore an unknown state, keep the stored one and warn once', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        feed(sync, line("eth2", "wobbling"), line("eth2", "wobbling"));
        expect(events).to.be.deep.equal([]);
        expect(sync._lastStates.get("eth2")).to.be.equal("forwarding");
        expect(sync.applied).to.be.deep.equal([]);
        expect(logs.warn.length).to.be.equal(1);
      });
    });

    describe('line formats', function(){
      it('should publish a line with the extra state token after the ifname', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        feed(sync, goldLine("eth2", "learning"));
        expect(events.length).to.be.equal(1);
        expect(events[0].slice(0, 3)).to.be.deep.equal(["bridge_port_stp_state", "eth2", 1]);
      });
    });

    describe('order', function(){
      it('should publish two quick transitions as two messages in order', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        feed(sync, line("eth2", "blocking"), line("eth2", "forwarding"));
        expect(events.map(e => [e[2], e[3].current_state, e[3].last_state])).to.be.deep.equal([
          [2, "discarding", "forwarding"], [0, "forwarding", "discarding"],
        ]);
      });

      it('should keep each port\'s messages apart when two ports change at once', ()=> {
        const sync = newSync();
        sync._lastStates.set("eth2", "forwarding");
        sync._lastStates.set("eth3", "forwarding");
        feed(sync, line("eth2", "blocking"), line("eth3", "blocking"));
        expect(events.map(e => [e[1], e[3].current_state, e[3].last_state])).to.be.deep.equal([
          ["eth2", "discarding", "forwarding"], ["eth3", "discarding", "forwarding"],
        ]);
      });

      describe('timestamps', function(){
        const T = 1700000000000;
        // the lines are handled in one millisecond: the ts is taken while they are handled
        function feedAt(sync, ...lines) {
          const origNow = Date.now;
          Date.now = () => T;
          try {
            feed(sync, ...lines);
          } finally {
            Date.now = origNow;
          }
        }

        it('should not let two messages of one port tie in time', ()=> {
          const sync = newSync();
          sync._lastStates.set("eth2", "forwarding");
          feedAt(sync, line("eth2", "learning"), line("eth2", "forwarding"));
          expect(events.map(e => e[3].current_state)).to.be.deep.equal(["learning", "forwarding"]);
          expect(events.map(e => e[4])).to.be.deep.equal([T, T + 1]);
        });

        it('should keep the ts of another port independent', ()=> {
          const sync = newSync();
          sync._lastStates.set("eth2", "forwarding");
          sync._lastStates.set("eth3", "forwarding");
          feedAt(sync, line("eth2", "learning"), line("eth2", "forwarding"), line("eth3", "blocking"));
          expect(events.slice(2).map(e => [e[1], e[4]])).to.be.deep.equal([["eth3", T]]);
        });
      });
    });

    describe('vlan port state mirroring', function(){
      it('should still apply every state of the own bridge, published or not', ()=> {
        const sync = newSync();
        feed(sync, line("eth2", "forwarding"), line("eth2", "forwarding"), line("eth2", "blocking"), line("eth2", "wobbling"));
        expect(sync.applied).to.be.deep.equal([["eth2", 3], ["eth2", 3], ["eth2", 4]]);
      });
    });

    describe('startMonitor', function(){
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const origReadFile = fsp.readFile;
      const origReaddir = fsp.readdir;
      const origSyncTimeout = BridgePortStateSync.INITIAL_SYNC_TIMEOUT_MS;
      const origPath = process.env.PATH;
      let dir, sync;

      before(() => {
        // a `bridge` that stays quiet, so startMonitor can run without watching real links
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bridge-"));
        fs.writeFileSync(path.join(dir, "bridge"), "#!/bin/sh\nexec sleep 30\n", {mode: 0o755});
      });
      after(() => {
        fs.unlinkSync(path.join(dir, "bridge"));
        fs.rmdirSync(dir);
      });
      beforeEach(() => {
        process.env.PATH = `${dir}${path.delimiter}${origPath}`;
        BridgePortStateSync.INITIAL_SYNC_TIMEOUT_MS = 10;
        fsp.readdir = async () => [];
        sync = newSync();
      });
      afterEach(async () => {
        await sync.stopMonitor();
        process.env.PATH = origPath;
        BridgePortStateSync.INITIAL_SYNC_TIMEOUT_MS = origSyncTimeout;
        fsp.readFile = origReadFile;
        fsp.readdir = origReaddir;
      });

      it('should publish each member\'s state read from sysfs as its initial state', async()=> {
        fsp.readFile = async (file) => file.includes("/eth2/") ? "3\n" : "4\n";
        await sync.startMonitor(["eth2", "eth3"]);
        expect(events.map(e => [e[1], e[2], e[3].current_state, e[3].last_state])).to.be.deep.equal([
          ["eth2", 0, "forwarding", null], ["eth3", 2, "discarding", null],
        ]);
        expect(sync._lastStates.get("eth2")).to.be.equal("forwarding");
        expect(sync._lastStates.get("eth3")).to.be.equal("discarding");
        expect(sync.applied).to.be.deep.equal([["eth2", 3], ["eth3", 4]]);
        feed(sync, line("eth2", "disabled"));
        expect(events.length).to.be.equal(3);
        expect(events[2][3].current_state).to.be.equal("disabled");
        expect(events[2][3].last_state).to.be.equal("forwarding");
      });

      it('should not seed a member whose state cannot be read', async()=> {
        fsp.readFile = async () => { throw new Error("ENOENT"); };
        await sync.startMonitor(["eth2"]);
        expect(sync._lastStates.size).to.be.equal(0);
        expect(sync.applied).to.be.deep.equal([]);
      });

      it('should not let an older sysfs read overwrite a newer line', async()=> {
        let release;
        fsp.readFile = () => new Promise(resolve => { release = () => resolve("3\n"); });
        const started = sync.startMonitor(["eth2"]);
        await new Promise(resolve => setImmediate(resolve));
        // the line is newer than the read that is still pending
        sync._handleLine(line("eth2", "blocking"));
        release();
        await started;
        expect(sync._lastStates.get("eth2")).to.be.equal("discarding");
        feed(sync, line("eth2", "forwarding"));
        expect(events.map(e => [e[3].current_state, e[3].last_state])).to.be.deep.equal([
          ["discarding", null], ["forwarding", "discarding"],
        ]);
      });

      it('should forget the states when the monitor stops', async()=> {
        fsp.readFile = async () => "3\n";
        await sync.startMonitor(["eth2"]);
        await sync.stopMonitor();
        expect(sync._lastStates.size).to.be.equal(0);
        // the next line is a first sighting again, not a change from the state before the stop
        events.length = 0;
        feed(sync, line("eth2", "blocking"));
        expect(events.length).to.be.equal(1);
        expect(events[0][3].current_state).to.be.equal("discarding");
        expect(events[0][3].last_state).to.be.equal(null);
      });
    });
  });
});
