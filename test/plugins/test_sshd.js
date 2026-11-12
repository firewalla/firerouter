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
const SSHDPlugin = stub.load(require.resolve('../../plugins/sshd/sshd_plugin.js'));

const LAN = 0, OTHER = 1, WAN = 2;

describe('Test sshd plugin', function(){
  this.timeout(10000);

  // sshd plugins apply concurrently, one reload after all of them instead of one per interface
  describe('scheduleReload', function(){
    const origWrite = SSHDPlugin.writeListenAddresses;
    let writes = 0;
    const log = { error: () => {}, warn: () => {}, info: () => {} };

    beforeEach(() => {
      stub.reset();
      writes = 0;
      SSHDPlugin.writeListenAddresses = async () => { writes++; };
    });
    afterEach(() => {
      SSHDPlugin.writeListenAddresses = origWrite;
    });

    it('should run reload_sshd.sh once for several reloads in a row, after the delay', async () => {
      SSHDPlugin.scheduleReload(log);
      SSHDPlugin.scheduleReload(log);
      SSHDPlugin.scheduleReload(log);
      expect(stub.matching("reload_sshd.sh").length).to.be.equal(0);
      await new Promise(resolve => setTimeout(resolve, 3500));
      expect(writes).to.be.equal(1);
      expect(stub.matching("reload_sshd.sh").length).to.be.equal(1);
    });

    it('should drop ssh on an interface turned off, and reload once', async () => {
      const plugin = stub.build(SSHDPlugin, "br7", { enabled: false });
      await plugin.apply();
      expect(stub.matching("FR_SSH -i br7 -p tcp --dport 22 -j DROP").length).to.be.equal(1);
      await new Promise(resolve => setTimeout(resolve, 3500));
      expect(stub.matching("reload_sshd.sh").length).to.be.equal(1);
    });
  });

  describe('selectListenAddresses', function(){
    it('should listen on every address within the budget', () => {
      const entries = [
        { intf: "br0", ip: "192.168.1.1", rank: LAN },
        { intf: "eth0", ip: "203.0.113.2", rank: WAN },
      ];
      const { listening, dropped } = SSHDPlugin.selectListenAddresses(entries, 15);
      expect(listening.map(e => e.ip)).to.eql(["192.168.1.1", "203.0.113.2"]);
      expect(dropped).to.eql([]);
    });

    // sshd exits on a 17th listen socket, so the 16th network has to be left out rather than all of them
    it('should keep the first 15 addresses and leave out the rest', () => {
      const entries = [];
      for (let i = 1; i <= 17; i++)
        entries.push({ intf: `br${i}`, ip: `10.0.${i}.1`, rank: LAN });
      const { listening, dropped } = SSHDPlugin.selectListenAddresses(entries, 15);
      expect(listening.length).to.be.equal(15);
      expect(listening[14]).to.eql({ intf: "br15", ip: "10.0.15.1" });
      expect(dropped).to.eql([{ intf: "br16", ip: "10.0.16.1" }, { intf: "br17", ip: "10.0.17.1" }]);
    });

    it('should keep LAN before other interfaces and WAN last, numbers in order within each', () => {
      const entries = [
        { intf: "eth0", ip: "203.0.113.2", rank: WAN },
        { intf: "wg0", ip: "10.9.0.1", rank: OTHER },
        { intf: "br10", ip: "10.0.10.1", rank: LAN },
        { intf: "br2", ip: "10.0.2.1", rank: LAN },
      ];
      const { listening, dropped } = SSHDPlugin.selectListenAddresses(entries, 3);
      expect(listening.map(e => e.intf)).to.eql(["br2", "br10", "wg0"]);
      expect(dropped.map(e => e.intf)).to.eql(["eth0"]);
    });

    // a network with two addresses takes two sockets
    it('should count every address of a network', () => {
      const entries = [
        { intf: "br0", ip: "192.168.1.1", rank: LAN },
        { intf: "br0", ip: "192.168.2.1", rank: LAN },
        { intf: "br1", ip: "192.168.3.1", rank: LAN },
      ];
      const { listening, dropped } = SSHDPlugin.selectListenAddresses(entries, 2);
      expect(listening.map(e => e.ip)).to.eql(["192.168.1.1", "192.168.2.1"]);
      expect(dropped.map(e => e.ip)).to.eql(["192.168.3.1"]);
    });

    it('should not spend a socket on the same address twice', () => {
      const entries = [
        { intf: "br0", ip: "192.168.1.1", rank: LAN },
        { intf: "br0.10", ip: "192.168.1.1", rank: LAN },
        { intf: "br1", ip: "192.168.3.1", rank: LAN },
      ];
      const { listening, dropped } = SSHDPlugin.selectListenAddresses(entries, 2);
      expect(listening.map(e => e.ip)).to.eql(["192.168.1.1", "192.168.3.1"]);
      expect(dropped).to.eql([]);
    });

    it('should listen on nothing when the budget is used up', () => {
      const { listening, dropped } = SSHDPlugin.selectListenAddresses([{ intf: "br0", ip: "192.168.1.1", rank: LAN }], 0);
      expect(listening).to.eql([]);
      expect(dropped.length).to.be.equal(1);
    });
  });
});
