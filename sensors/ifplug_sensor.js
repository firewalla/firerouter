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

  async toggleLedNormalVisible() {
    const etherCarrierDetected = Object.keys(ifStates).some(iface => {
      const intfPlugin = pl.getPluginInstance("interface", iface);
      if (intfPlugin && intfPlugin.constructor.name === "PhyInterfacePlugin" && ifStates[iface] === 1)
        return true;
      return false;
    });
    if (etherCarrierDetected)
      await platform.ledNormalVisibleStop();
    else
      await platform.ledNormalVisibleStart();
  }

  async stopMonitoringInterface(iface) {
      await exec(`sudo ifplugd -pq -k -i ${iface}`).catch((err) => {});
  }

  async startMonitoringInterface(iface) {
    const upDelay = this.config.up_delay || 5;
    const downDelay = this.config.down_delay || 5;
    // specify -a so that ifplugd will not automatically enable interface, otherwise may cause trouble while adding slave into bond
    await exec(`sudo ifplugd -pq -a -i ${iface} -f -u ${upDelay} -d ${downDelay}`).catch((err) => {
      this.log.error(`Failed to start ifplugd on ${iface}`);
    });
  }

  async run() {
    const ifaces = await ncm.getPhyInterfaceNames();
    const era = require('../event/EventRequestApi');
    for (const iface of ifaces) {
      await exec(`sudo ip link set ${iface} up`).catch((err) => {});
      await this.stopMonitoringInterface(iface);
      await this.startMonitoringInterface(iface);
      ifStates[iface] = await exec(`cat /sys/class/net/${iface}/carrier`).then(r => Number(r.stdout.trim())).catch((err) => 0);
    }
    this.log.info("initial ifStates:",ifStates);
    setTimeout(() => {
      this.toggleLedNormalVisible().catch((err) => {
        this.log.error("Failed to toggle led visible", err.message);
      });
    }, 60000)

    sclient.on("message", (channel, message) => {
      switch (channel) {
        case "ifup": {
          const iface = message;
          platform.toggleEthernetLed(iface, true);
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
          if (intfPlugin && intfPlugin.constructor.name === "PhyInterfacePlugin") {
            ifStates[iface] = 1;
            this.log.info("ifStates:",ifStates);
            era.addStateEvent(EventConstants.EVENT_ETHER_STATE, iface, 0);
          }
          this.toggleLedNormalVisible().catch((err) => {
            this.log.error("Failed to toggle led visible", err.message);
          });
          break;
        }
        case "ifdown": {
          const iface = message;
          platform.toggleEthernetLed(iface, false);
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
          if (intfPlugin && intfPlugin.constructor.name === "PhyInterfacePlugin") {
            ifStates[iface] = 0;
            this.log.info("ifStates:",ifStates);
            era.addStateEvent(EventConstants.EVENT_ETHER_STATE, iface, 1);
          }
          this.toggleLedNormalVisible().catch((err) => {
            this.log.error("Failed to toggle led visible", err.message);
          });
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
