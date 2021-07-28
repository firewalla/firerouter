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

class WPAConnectionSensor extends Sensor {

  async run() {
    sclient.on("message", (channel, message) => {
      let eventType = null;
      switch (channel) {
        case "wpa.connected": {
          eventType = event.EVENT_WPA_CONNECTED;
          break;
        }
        case "wpa.disconnected": {
          eventType = event.EVENT_WPA_DISCONNECTED;
          break;
        }
        default:
          return;
      }
      const iface = message;
      const intfPlugin = pl.getPluginInstance("interface", iface);
      if (intfPlugin) {
        const e = event.buildEvent(eventType, { intf: iface });
        intfPlugin.propagateEvent(e);
      }
    });

    sclient.subscribe("wpa.connected");
    sclient.subscribe("wpa.disconnected");
  }

}

module.exports = WPAConnectionSensor;