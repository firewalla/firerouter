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
const VLANInterfacePlugin = stub.load(require.resolve('../../plugins/interface/vlan_intf_plugin.js'));
let log = require('../../util/logger.js')(__filename, 'info');

describe('Test vlan interface plugin', function(){
  this.timeout(30000);

  beforeEach(() => stub.reset());

  describe('vid', function(){
    // vid is interpolated into `ip link add ... type vlan id <vid>` before the lower interface is
    // ever looked up, so an invalid one must not reach the command
    it('should refuse a vid that is not a number', async()=> {
      const plugin = stub.build(VLANInterfacePlugin, "eth0.100",
        {intf: "eth0", vid: "100 protocol 802.1Q; touch /tmp/pwn; #", enabled: true});
      let threw = false;
      await plugin.createInterface().catch(() => { threw = true; });
      expect(threw, 'createInterface should reject an invalid vid').to.be.true;
      expect(stub.matching("touch /tmp/pwn").length).to.be.equal(0);
      expect(stub.calls.length).to.be.equal(0);
    });

    it('should refuse a vid outside the 802.1Q range', async()=> {
      for (const vid of [0, 4095, -1]) {
        stub.reset();
        const plugin = stub.build(VLANInterfacePlugin, "eth0.100", {intf: "eth0", vid, enabled: true});
        let threw = false;
        await plugin.createInterface().catch(() => { threw = true; });
        expect(threw, `vid ${vid} should be rejected`).to.be.true;
        expect(stub.calls.length).to.be.equal(0);
      }
    });

    it('should build the link command for a valid vid', async()=> {
      const plugin = stub.build(VLANInterfacePlugin, "eth0.100", {intf: "eth0", vid: 100, enabled: true});
      // the lower interface lookup after the command fails without a loader, that is expected here
      await plugin.createInterface().catch(() => {});
      expect(stub.calls.length).to.be.at.least(1);
      log.debug("vlan cmd", stub.calls[0]);
      expect(stub.calls[0]).to.contain("type vlan id 100");
    });
  });
});
