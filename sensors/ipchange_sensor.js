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
const ipChangePublishScript = `${r.getFireRouterHome()}/scripts/ip_change_publish`;
const exec = require('child-process-promise').exec;
const pl = require('../plugins/plugin_loader.js');
const event = require('../core/event.js');

const sclient = require('../util/redis_manager.js').getSubscriptionClient();

class IPChangeSensor extends Sensor {
  
  static async prepare() {
    await exec(`sudo cp ${ipChangePublishScript} /etc/dhcp/dhclient-exit-hooks.d/`).catch((err) => {});
  }

  async run() {
    sclient.on("message", (channel, message) => {
      switch (channel) {
        case "pppoe.ip_change":
        case "dhclient.ip_change": {
          const iface = message;
          const intfPlugin = pl.getPluginInstance("interface", iface);
          if (intfPlugin) {
            const e = event.buildEvent(event.EVENT_IP_CHANGE, {intf: iface});
            if (this.config.delay) {
              setTimeout(() => {
                intfPlugin.propagateEvent(e);
              }, this.config.delay * 1000);
            } else {
              intfPlugin.propagateEvent(e);
            }
          }
          break;
        }
        default:
      }
    });

    sclient.subscribe("dhclient.ip_change");
  }
}

module.exports = IPChangeSensor;