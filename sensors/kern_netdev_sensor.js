/*    Copyright 2021 Firewalla Inc
 *
 *    This program is free software: you can redistribute it and/or modify
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
'use strict';

const Sensor = require('./sensor.js');
const rclient = require('../util/redis_manager.js').getRedisClient()
const exec = require('child-process-promise').exec;
const LogReader = require('../util/LogReader')


// watch kern.log for unexpected error log:
// `unregister_netdevice: waiting for {iface} to become free`
// if count >= threshold (default 3) times, mark and reboot system.
// config:
//   kernlog: kern.log path (also be set by env `KERN_LOG`, default /var/log/kern.log)
//   kern_netdev_threshold_count: threshold to reboot (default 3)
//   kern_netdev_rkey: set reboot timestamp (default `sys:kern:unreg_netdev_reboot`)
//   kern_netdev_enable_reboot: explicitly set true to enable reboot

class KernNetDeviceSensor extends Sensor {
    async run(){
        this.errorCount = 0;
        this.kernlog = this.config.kernlog;
        this.kernNetThreshold = this.config.kern_netdev_threshold_count || 3;
        this.kernNetdevRkey = this.config.kern_netdev_rkey || 'sys:kern:unreg_netdev_reboot';
        this.kernNetRegexp = /unregister_netdevice: waiting for .* to become free/;

        if (!this.kernlog) {
            this.kernlog = process.env.KERN_LOG || '/var/log/kern.log';
        }

        this.watcher = new LogReader(this.kernlog, true);
        this.watcher.on('line', this.watchLog.bind(this));
        this.watcher.watch();
    }


  async watchLog(line) {
    if (line.match(this.kernNetRegexp)) {
        this.errorCount++;
        this.log.warn(`kernel unregister_netdevice detected (${this.errorCount}): ${line}`);
        if (this.errorCount >= this.kernNetThreshold) {
            await rclient.setAsync(this.kernNetdevRkey, new Date().getTime()/1000);
            if (this.config.kern_netdev_enable_reboot === true) {
              this.log.error('kernel unregister_netdevice hit threshold, system reboot!');
              await this.reboot()
            } else {
              this.log.warn('kernel unregister_netdevice hit threshold, need system reboot');
            }
        }
     }
  }

  async reboot(){
    await exec(`sudo reboot`)
  }

}

module.exports = KernNetDeviceSensor
