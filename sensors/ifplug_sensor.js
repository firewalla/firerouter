/*    Copyright 2019 Firewalla Inc
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
const ifupdownPublishScript = `${r.getFireRouterHome()}/scripts/ifupdown_publish`;
const exec = require('child-process-promise').exec;
const ncm = require('../core/network_config_mgr.js');
const pl = require('../plugins/plugin_loader.js');
const event = require('../core/event.js');

const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const firestatusBaseURL = "http://127.0.0.1:9966";
const rp = require('request-promise');

class IfPlugSensor extends Sensor {

  static async prepare() {
    await exec(`sudo rm -rf /etc/ifplugd/action.d/*`).catch((err) => {});
    await exec(`sudo cp ${ifupdownPublishScript} /etc/ifplugd/action.d/`).catch((err) => {});
    this.ethernetConnections = {}
  }

  async run() {
    const ifaces = await ncm.getPhyInterfaceNames();
    const upDelay = this.config.up_delay || 5;
    const era = require('../event/EventRequestApi');
    for (let iface of ifaces) {
      await exec(`sudo ip link set ${iface} up`).catch((err) => {});
      await exec(`sudo ifplugd -pq -k -i ${iface}`).catch((err) => {});
      await exec(`sudo ifplugd -pq -i ${iface} -f -u ${upDelay}`).catch((err) => {
        this.log.error(`Failed to start ifplugd on ${iface}`);
      });
    }

    sclient.on("message", (channel, message) => {
      const EVENT_STATE_TYPE = "ethernet_state";
      switch (channel) {
        case "ifup": {
          const iface = message;
          this.ethernetConnections[iface] = "up"
          if ( this.ethernetConnections.eth0 === "up" || this.ethernetConnections.eth1 === "up" ) {
            await rp(`${firestatusBaseURL}/resolve?name=wan&type=normal_visible`).catch((err) => {
              log.error("Failed to set LED as WAN not normal visible");
            });
          }
          const intfPlugin = pl.getPluginInstance("interface", iface);
          if (intfPlugin) {
            let e = null;
            switch (intfPlugin.constructor.name) {
              case "WLANInterfacePlugin":
                e = event.buildEvent(event.EVENT_WLAN_UP, {intf: iface});
                break;
              default:
                e = event.buildEvent(event.EVENT_IF_UP, {intf: iface});
            }
            intfPlugin.propagateEvent(e);
          }
          // filter out VPN interface
          if ( iface !== 'tun_fwvpn') era.addStateEvent(EVENT_STATE_TYPE, iface, 0);
          break;
        }
        case "ifdown": {
          const iface = message;
          this.ethernetConnections[iface] = "down"
          if ( this.ethernetConnections.eth0 === "down" && this.ethernetConnections.eth1 === "down" ) {
            await rp(`${firestatusBaseURL}/fire?name=wan&type=normal_visible`).catch((err) => {
              log.error("Failed to set LED as WAN normal visible");
            });
          }
          const intfPlugin = pl.getPluginInstance("interface", iface);
          if (intfPlugin) {
            let e = null;
            switch (intfPlugin.constructor.name) {
              case "WLANInterfacePlugin":
                e = event.buildEvent(event.EVENT_WLAN_DOWN, {intf: iface});
                break;
              default:
                e = event.buildEvent(event.EVENT_IF_DOWN, {intf: iface});
            }
            intfPlugin.propagateEvent(e);
          }
          // filter out VPN interface
          if ( iface !== 'tun_fwvpn') era.addStateEvent(EVENT_STATE_TYPE, iface, 1);
          break;
        }
        default:
      }
    });

    sclient.subscribe("ifup");
    sclient.subscribe("ifdown");
  }
}

module.exports = IfPlugSensor;