/*    Copyright 2016-2024 Firewalla Inc.
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

const ncm = require('../../core/network_config_mgr.js');
let log = require('../../util/logger.js')(__filename, 'info');
const rclient = require('../../util/redis_manager').getRedisClient();

describe('Test network config manager', function(){
  this.timeout(30000);
  beforeEach((done) => (
    async() => {
      this.testkey = "sysdb:transaction:networkConfig";
      this.origin = await rclient.getAsync(this.testkey);
      this.nwkey = "sysdb:networkConfig";
      this.nw = await rclient.getAsync(this.nwkey);
      done();
    })()
  );

  afterEach((done) => (
    async() => {
      await rclient.setAsync(this.testkey, this.origin);
      await rclient.setAsync(this.nwkey, this.nw);
      done();
    })()
  );

  it('should validate network ncid', async()=> {
    const nwConfig = {"version":1,"interface":{"phy":{"eth0":{}}},"ts":1726648571944};
    expect(await ncm.validateNcid(nwConfig, true)).to.be.undefined;

    await rclient.setAsync(this.testkey, `{"version":1,"interface":{"phy":{"eth0":{}}},"ts":1726648571944, "ncid":"test"}`);
    expect(await ncm.validateNcid(nwConfig, true)).to.be.undefined;
  });

  it('should fail to validate network ncid', async()=> {
    await rclient.setAsync(this.testkey, `{"version":1,"interface":{"phy":{"eth0":{}}},"ts":1726648571944, "ncid":"test"}`);

    const nwConfig = {"version":1,"interface":{"phy":{"eth0":{}}},"ts":1726648571944, ncid: "2df97f9efb0ad09b7201726801377449"};
    expect(await ncm.validateNcid(nwConfig, true)).to.be.eql(["ncid not match"]);

    expect(await ncm.validateNcid(nwConfig, true, true)).to.be.undefined;
  });

});
