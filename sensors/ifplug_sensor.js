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
const PlatformLoader = require('../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()
const EventConstants = require('../event/EventConstants.js');

const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const ifStates = {}

class IfPlugSensor extends Sensor {

  static async prepare() {
    await exec(`sudo rm -rf /etc/ifplugd/action.d/*`).catch((err) => {});
    await exec(`sudo cp ${ifupdownPublishScript} /etc/ifplugd/action.d/`).catch((err) => {});
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
    try {
        ifStates.eth0 = await exec("ip --br link show dev eth0|awk '{print $2}'").then(result => result.stdout.trim());
        ifStates.eth1 = await exec("ip --br link show dev eth1|awk '{print $2}'").then(result => result.stdout.trim());
    } catch (err) {
        this.log.error("Failed to get initial state of eth0 or eth1",err);
    }
    this.log.info("initial ifStates:",ifStates);

    sclient.on("message", (channel, message) => {
      switch (channel) {
        case "ifup": {
          const iface = message;
          ifStates[iface] = "UP"
          this.log.info("ifStates:",ifStates);
          if ( ifStates.eth0 === "UP" || ifStates.eth1 === "UP" ) {
              platform.ledNormalVisibleStop();
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
          if (intfPlugin.constructor.name === "PhyInterfacePlugin")
            era.addStateEvent(EventConstants.EVENT_ETHER_STATE, iface, 0);
          break;
        }
        case "ifdown": {
          const iface = message;
          ifStates[iface] = "DOWN"
          this.log.info("ifStates:",ifStates);
          if ( ifStates.eth0 === "DOWN" && ifStates.eth1 === "DOWN" ) {
            platform.ledNormalVisibleStart();
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
          // ethernet state change only generated on physical interfaces
          if (intfPlugin.constructor.name === "PhyInterfacePlugin")
            era.addStateEvent(EventConstants.EVENT_ETHER_STATE, iface, 1);
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