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

const rclient = require('../../util/redis_manager.js').getRedisClient()
let KernNetDeviceSensor = require("../../sensors/kern_netdev_sensor.js");

describe('Test kern.log unregister_netdevice sensor', function(){
  this.timeout(30000);

  beforeEach((done) => {
    const kernlog = `./kern.test.log`;
    const kern_netdev_rkey = 'sys:kern:unreg_netdev_reboot:dev';
    this.sensor = new KernNetDeviceSensor({kernlog, kern_netdev_rkey});

    done();
  });

  afterEach((done) => {
    (async() =>{
        done();
    })();
  });

  it('should hit threshold', async()=> {
    this.sensor.errorCount = 0;
    this.sensor.kernNetThreshold = this.sensor.config.kern_netdev_threshold_count || 3;
    this.sensor.kernNetdevRkey = this.sensor.config.kern_netdev_rkey;
    this.sensor.kernNetRegexp = /unregister_netdevice: waiting for .* to become free/;

    const line = 'Jan 11 02:15:08 localhost kernel: [1144788.478890] unregister_netdevice: waiting for br1 to become free. Usage count = 2';
    this.sensor.watchLog(line);
    this.sensor.watchLog(line);
    this.sensor.watchLog(line);
    this.sensor.watchLog(line);

    const ts = await rclient.getAsync('sys:kern:unreg_netdev_reboot:dev');
    const delTs = new Date().getTime()/1000 - ts;
    this.sensor.log.info('sys:kern:unreg_netdev_reboot:dev', ts)
    expect(delTs).to.lessThan(1);
  });

  it('should run and watch file', async()=> {
    await this.sensor.run();
  });
});
