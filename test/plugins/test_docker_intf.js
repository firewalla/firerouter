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
const DockerInterfacePlugin = stub.load(require.resolve('../../plugins/interface/docker_intf_plugin.js'));

describe('Test docker interface plugin', function(){
  this.timeout(30000);

  beforeEach(() => stub.reset());

  describe('network creation options', function(){
    // driver and driverOptions are concatenated into `docker network create`, so both are held to
    // the character set docker itself uses
    it('should refuse a driver carrying shell metacharacters', async()=> {
      const plugin = stub.build(DockerInterfacePlugin, "docker0",
        {driver: "bridge; touch /tmp/pwn; #", enabled: true});
      let threw = false;
      await plugin.createInterface().catch(() => { threw = true; });
      expect(threw, 'createInterface should reject an invalid driver').to.be.true;
      expect(stub.matching("touch /tmp/pwn").length).to.be.equal(0);
    });

    it('should refuse a driver option carrying shell metacharacters', async()=> {
      const plugin = stub.build(DockerInterfacePlugin, "docker0",
        {driver: "bridge", driverOptions: ["com.docker.network.bridge.name=x; touch /tmp/pwn; #"], enabled: true});
      let threw = false;
      await plugin.createInterface().catch(() => { threw = true; });
      expect(threw, 'createInterface should reject an invalid driver option').to.be.true;
      expect(stub.matching("touch /tmp/pwn").length).to.be.equal(0);
    });
  });
});
