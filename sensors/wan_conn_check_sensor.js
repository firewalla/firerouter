/*    Copyright 2020 Firewalla Inc
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
const r = require('../util/firerouter.js');
const exec = require('child-process-promise').exec;
const pl = require('../plugins/plugin_loader.js');
const event = require('../core/event.js');
const era = require('../event/EventRequestApi.js');
const EventConstants = require('../event/EventConstants.js');
const _ = require('lodash');

class WanConnCheckSensor extends Sensor {

  async run() {
    setTimeout(() => {
      this._checkWanConnectivity().catch((err) => {
        this.log.error("Failed to do WAN connectivity check", err.message);
      });
      setInterval(() => {
        this._checkWanConnectivity().catch((err) => {
          this.log.error("Failed to do WAN connectivity check", err.message);
        });
      }, 20000);
    }, 60000);
  }

  async _checkWanConnectivity() {
    const wanIntfPlugins = Object.keys(pl.getPluginInstances("interface")).map(name => pl.getPluginInstance("interface", name)).filter(ifacePlugin => ifacePlugin.isWAN());
    const defaultPingTestIP = this.config.ping_test_ip || ["1.1.1.1", "8.8.8.8", "9.9.9.9"];
    const defaultPingTestCount = this.config.ping_test_count || 8;
    const defaultPingSuccessRate = this.config.ping_success_rate || 0.5;
    const defaultDnsTestDomain = this.config.dns_test_domain || "github.com";
    await Promise.all(wanIntfPlugins.map(async (wanIntfPlugin) => {
      const result = await wanIntfPlugin.checkWanConnectivity(defaultPingTestIP, defaultPingTestCount, defaultPingSuccessRate, defaultDnsTestDomain);
      if (!result)
        return;
      const active = result.active;
      const forceState = result.forceState;
      const failures = result.failures;
      const e = event.buildEvent(event.EVENT_WAN_CONN_CHECK, {intf: wanIntfPlugin.name, active: active, forceState: forceState, failures: failures});
      event.suppressLogging(e);
      wanIntfPlugin.propagateEvent(e);
    }));
  }
}

module.exports = WanConnCheckSensor;
