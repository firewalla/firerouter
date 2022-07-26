/*    Copyright 2022 Firewalla Inc.
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

const Sensor = require("./sensor.js");
const rclientDB0 = require('../util/redis_manager.js').getRedisClient(0);
const pclient = require('../util/redis_manager.js').getPublishClient()
const exec = require('child-process-promise').exec;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const GoldPlatform = require('../platform/gold/GoldPlatform')
const LogReader = require('../util/LogReader')

class RTWSensor extends Sensor {

  async watchLog(line) {
    // #define WLAN_REASON_UNSPECIFIED 1
    if (line.includes('alloc xmitbuf fail') || line.includes('xmit_status_check tx hang')) {
      if (++this.failCount >= this.config.fail_threshold_count && !this.reloading) {
        this.log.info('Threshold hit, reloading kernel module ...')
        pclient.publish('firerouter.wlan.xmitbuf_fail', '1')
        // sleep to allow IfPresenceSensor to catch the event
        this.reloading = true
        await exec(`sudo systemctl stop firerouter_hostapd@wlan1; sudo rmmod ${this.driver}; sleep 3; sudo modprobe ${this.driver}`)
        if (platform instanceof GoldPlatform && this.driver == '8821cu') {
          await exec('echo 4 > /proc/net/rtl8821cu/log_level')
        }
        this.reloading = false
        this.fialCount = 0
        await rclientDB0.incrAsync('sys:wlan:kernelReload:xmitbuf')
      }
    }
  }

  async run() {
    this.failCount = 0
    this.reloading = false
    this.logWatcher = new LogReader(this.config.log_file, true)
    this.logWatcher.on('line', this.watchLog.bind(this))
    this.logWatcher.watch()

    this.deriver = await platform.getWlanVendor()

    if (platform instanceof GoldPlatform && this.driver == '8821cu') {
      await exec('echo 4 > /proc/net/rtl8821cu/log_level')
    }
  }

}

module.exports = RTWSensor
