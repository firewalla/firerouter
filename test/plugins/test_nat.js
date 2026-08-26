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
const NatPlugin = stub.load(require.resolve('../../plugins/nat/nat_plugin.js'));

describe('Test nat plugin', function(){
  this.timeout(30000);

  beforeEach(() => stub.reset());

  describe('srcSubnets', function(){
    // each subnet goes into an SNAT rule, and wrapIptables hands that rule to a nested bash -c,
    // so anything that is not an address would be reparsed as shell
    it('should skip a subnet that is not an address', async()=> {
      const plugin = stub.build(NatPlugin, "x", {out: "eth0"});
      await plugin._updateSNATRules(["10.0.0.0/8", "10.0.0.0/8; touch /tmp/pwn; #"], "eth0", "add");
      expect(stub.matching("touch /tmp/pwn").length).to.be.equal(0);
      expect(stub.calls.length).to.be.equal(1);
      expect(stub.calls[0]).to.contain("-s 10.0.0.0/8");
    });

    it('should build a rule for every valid subnet', async()=> {
      const plugin = stub.build(NatPlugin, "x", {out: "eth0"});
      await plugin._updateSNATRules(["10.0.0.0/8", "192.168.0.0/16"], "eth0", "add");
      expect(stub.calls.length).to.be.equal(2);
    });
  });
});
