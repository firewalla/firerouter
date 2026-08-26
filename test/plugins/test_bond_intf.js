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
});
