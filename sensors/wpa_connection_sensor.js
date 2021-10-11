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

const Sensor = require("./sensor.js");
const r = require('../util/firerouter.js');
const event = require('../core/event.js');
const pl = require('../plugins/plugin_loader.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const exec = require('child-process-promise').exec;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const PurplePlatform = require('../platform/purple/PurplePlatform')
const era = require('../event/EventRequestApi.js');
const EventConstants = require('../event/EventConstants.js');
const util = require('../util/util.js');
const LogReader = require('../util/LogReader')
const _ = require('lodash');

class WPAConnectionSensor extends Sensor {

  async watchLog(line) {
    // #define WLAN_REASON_UNSPECIFIED 1
    if (line.includes('CTRL-EVENT-ASSOC-REJECT status_code=1')) {
      // ignore reject events within a minute as it could coming from multiple SSIDs
      const now = Date.now() / 1000
      if (!this.rejects.length || now - 60 > this.rejects[this.rejects.length-1]) {
        this.rejects.push(now)
        this.log.debug('added reject event', this.rejects)
        while (this.rejects[0] < now - this.config.reject_threshold_time_seconds) {
          const removed = this.rejects.shift()
          this.log.debug('removed reject', removed)
        }
        if (this.rejects.length >= this.config.reject_threshold_count) {
          this.log.info('Threshold hit, reloading kernal module ...')
          // sleep to allow IfPresenceSensor to catch the event
          await exec('sudo rmmod 88x2cs; sleep 3; sudo modprobe 88x2cs')
          this.rejects = []
          await rclient.incrAsync('sys:wlan:kernalReload')
        }
      }
    } else if (line.includes('CTRL-EVENT-CONNECTED')) {
      // reset counter
      this.rejects = []
      this.log.debug('connected event received, rejects cleard', this.rejects)
    }
  }

  async run() {
    if (!(platform instanceof PurplePlatform)) return

    this.rejects = []
    this.logWatcher = new LogReader(this.config.log_file, true)
    this.logWatcher.on('line', this.watchLog.bind(this))
    this.logWatcher.watch()

    this.reconfigFlags = {}
    sclient.on("message", async (channel, message) => {
      try {
        let eventType = null;
        let wpaState = false;
        switch (channel) {
          case "wpa.connected": {
            eventType = event.EVENT_WPA_CONNECTED;
            wpaState = true;
            break;
          }
          case "wpa.disconnected": {
            eventType = event.EVENT_WPA_DISCONNECTED;
            wpaState = false;
            break;
          }
          default:
            return;
        }
        this.log.debug('message received:', channel, message)
        const [iface, wpaId] = message.split(',', 2);
        const wpaCliPath = platform.getWpaCliBinPath();
        const intfPlugin = pl.getPluginInstance("interface", iface);
        if (intfPlugin) {
          const socketDir = `${r.getRuntimeFolder()}/wpa_supplicant/${iface}`;
          let ssid = null;
          if (!_.isEmpty(wpaId) && !isNaN(wpaId)) {
            ssid = await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${iface} get_network ${wpaId} ssid`)
              .then(result => result.stdout.trim())
              .then(str => str.startsWith('\"') && str.endsWith('\"') ?
                str.slice(1, -1) : util.parseHexString(str)
              ).catch(err => {
                this.log.error('Failed to get ssid', err)
                return null
              });
          }
          const ifaceName = intfPlugin.networkConfig && intfPlugin.networkConfig.meta && intfPlugin.networkConfig.meta.name;
          const ifaceUUID = intfPlugin.networkConfig && intfPlugin.networkConfig.meta && intfPlugin.networkConfig.meta.uuid;
          era.addActionEvent(EventConstants.EVENT_WPA_CONNECTION_STATE, wpaState ? 0 : 1, {
            "intf_name": ifaceName,
            "intf_uuid": ifaceUUID,
            "ssid": ssid,
            "intf": iface
          });
          const e = event.buildEvent(eventType, { intf: iface });
          intfPlugin.propagateEvent(e);
        }
      } catch(err) {
        this.log.error('Error on wpa event handling', err)
      }
    });

    sclient.subscribe("wpa.connected");
    sclient.subscribe("wpa.disconnected");
  }

}

module.exports = WPAConnectionSensor;
