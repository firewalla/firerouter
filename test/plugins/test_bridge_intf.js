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
});
