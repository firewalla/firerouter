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
const IGMPProxyPlugin = stub.load(require.resolve('../../plugins/igmp_proxy/igmp_proxy_plugin.js'));

describe('Test igmp proxy plugin', function(){
  this.timeout(30000);

  beforeEach(() => stub.reset());

  describe('altnets', function(){
    // each altnet goes into an iptables rule, and wrapIptables hands that rule to a nested bash -c,
    // so anything that is not an address would be reparsed as shell
    it('should skip an altnet that is not an address', async()=> {
      const plugin = stub.build(IGMPProxyPlugin, "eth0",
        {altnets: ["10.0.0.0/8", "10.0.0.0/8; touch /tmp/pwn; #"], downstream: {}});
      await plugin.updateIptables();
      expect(stub.matching("touch /tmp/pwn").length).to.be.equal(0);
      // the generic rule plus exactly one altnet rule
      expect(stub.calls.filter(c => c.includes("-s 10.0.0.0/8 ")).length).to.be.equal(1);
    });

    it('should accept valid altnets', async()=> {
      const plugin = stub.build(IGMPProxyPlugin, "eth0",
        {altnets: ["10.0.0.0/8", "192.168.0.0/16"], downstream: {}});
      await plugin.updateIptables();
      expect(stub.calls.filter(c => c.includes("FR_IGMP -s ")).length).to.be.equal(2);
    });
  });
});
