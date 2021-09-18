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
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const exec = require('child-process-promise').exec;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const era = require('../event/EventRequestApi.js');
const EventConstants = require('../event/EventConstants.js');
const ncm = require('../core/network_config_mgr')

class WPAConnectionSensor extends Sensor {

  async run() {
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
          if (wpaId !== undefined) {
            ssid = await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${iface} get_network ${wpaId} ssid | tr -d '"'`).then(result => result.stdout.trim()).catch((err) => null);
            if (eventType == event.EVENT_WPA_CONNECTED) {
              const freq = await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${iface} status | grep freq=`)
                .then(result => result.stdout.trim().split('=')[1])
                .catch(err => {
                  this.log.error('Error parsing wlan status', err)
                  return NaN
                });
              if (freq < 5000) {
                this.log.info(`Connected on freq ${freq}, looking for 5G options`)
                const availableWLANs = await ncm.getWlansViaWpaSupplicant()
                if (!availableWLANs || !availableWLANs.length) {
                  this.log.error('Failed to retrieve WLAN list, exit')
                  return
                }
                this.log.debug('availableWLANs', availableWLANs)
                const prioritizedNetworks = availableWLANs
                  .filter(n => n.ssid == ssid && n.freq > 5000 && n.signal > -80)
                this.log.debug('prioritizedNetworks', prioritizedNetworks)
                if (prioritizedNetworks.length) {
                  await ncm.switchWifi(iface, ssid, {freq_list: prioritizedNetworks.map(p => p.freq).join(' ')})
                } else {
                  this.log.info('Nothing better is found')
                }
              }
            } else if (eventType == event.EVENT_WPA_DISCONNECTED) {
              await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${iface} reconfig`)
            }
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
