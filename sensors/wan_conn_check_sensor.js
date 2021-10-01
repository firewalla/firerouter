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
const Message = require('../core/Message.js');
const ncm = require('../core/network_config_mgr.js');
const event = require('../core/event.js');
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const pclient = require('../util/redis_manager.js').getPublishClient();
const _ = require('lodash');
const InterfaceBasePlugin = require('../plugins/interface/intf_base_plugin.js');

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

    const checkInterval = 20;

    setInterval(() => {
      this.log.info(`Checking if should send wan down notifications for every ${checkInterval} mins`);
      this._checkCaptive().catch((err) => {
        this.log.error("Failed to check if should send wan down notifications", err.message);
      });
    }, checkInterval * 60 * 1000);

    this.hookOnInterfaceEvents();
  }

  // run immediately when interface is up/down
  hookOnInterfaceEvents() {
    sclient.on("message", (channel, message) => {
      switch (channel) {
      case "ifdown": {
        const intf = message;
        const intfPlugin = pl.getPluginInstance("interface", intf);
        if (intfPlugin) {
          // ifdown of an underlying interface will affect the wan connectivity of the upper layer wan interface
          const wanSubscriberNames = (intfPlugin.getRecursiveSubscriberPlugins() || []).filter(plugin => plugin && plugin instanceof InterfaceBasePlugin && plugin.isWAN()).map(plugin => plugin.name);
          if (intfPlugin.isWAN())
            wanSubscriberNames.push(intf);
          this._checkWanConnectivity([wanSubscriberNames]).catch((err) => {
            this.log.error("Failed to do WAN connectivity check", err.message);
          });
        }
        break;
      }
      default:
      }
    });

    sclient.subscribe("ifdown");
  }

  async _checkWanConnectivity(ifaces = null) {
    const wanIntfPlugins = Object.keys(pl.getPluginInstances("interface")).filter(name => !_.isArray(ifaces) || ifaces.includes(name)).map(name => pl.getPluginInstance("interface", name)).filter(ifacePlugin => ifacePlugin && ifacePlugin.isWAN());
    const defaultPingTestIP = this.config.ping_test_ip || ["1.1.1.1", "8.8.8.8", "9.9.9.9"];
    const defaultPingTestCount = this.config.ping_test_count || 8;
    const defaultPingSuccessRate = this.config.ping_success_rate || 0.5;
    const defaultDnsTestDomain = this.config.dns_test_domain || "github.com";
    await Promise.all(wanIntfPlugins.map(async (wanIntfPlugin) => {
      const result = await wanIntfPlugin.checkWanConnectivity(defaultPingTestIP, defaultPingTestCount, defaultPingSuccessRate, defaultDnsTestDomain, null, true);
      this._checkHttpConnectivity(wanIntfPlugin).catch((err) => {
        this.log.error("Got error when checking http, err:", err.message);
      });

      if (!result)
        return;
      const active = result.active;
      const forceState = result.forceState;
      const failures = result.failures;
      const e = event.buildEvent(event.EVENT_WAN_CONN_CHECK, {intf: wanIntfPlugin.name, active: active, forceState: forceState, failures: failures});
      event.suppressLogging(e);
      if (!active)
        this.log.warn(`Wan connectivity test failed on ${wanIntfPlugin.name}, failures: ${JSON.stringify(failures)}`);
      wanIntfPlugin.propagateEvent(e);
    }));
  }

  async _checkCaptive() {
    const state = ncm.isAnyWanConnected();

    // if http status code on all active wans is 3xx, bring bluetooth up
    if(state && state.wans) {
      const intfStates = Object.values(state.wans);

      const statesWith3xx = intfStates.filter((s) => s.http &&
                                                    s.http.statusCode >= 300 &&
                                                    s.http.statusCode < 400);

      if(!_.isEmpty(statesWith3xx)) {
        // bring bluetooth up if captive
        await pclient.publishAsync(Message.MSG_FIRERESET_BLUETOOTH_CONTROL, "1").catch((err) => {});
      }
    }
  }

  // test until http status code is 2xx or test status is reset
  async _checkHttpConnectivity(intfPlugin, options = {}) {
    const sites = ["http://captive.apple.com", "http://cp.cloudflare.com", "http://clients3.google.com/generate_204"];

    const r2c = await intfPlugin.readyToConnect();
    if(!r2c) {
      this.log.debug("no need to check http as physically not ready to connect");
      return;
    }

    const lastWanStatus = intfPlugin.getWanStatus();
    const lastHttpResult = lastWanStatus && lastWanStatus.http;
    const recentDownTime = (lastWanStatus && lastWanStatus.recentDownTime) || 0;

    const isLastHttpSuccess = lastHttpResult && (lastHttpResult.statusCode >= 200 && lastHttpResult.statusCode < 300);
    const testAtLeastOnceAfterPingTestPass = lastHttpResult && (lastHttpResult.ts >  recentDownTime);

    if(isLastHttpSuccess && testAtLeastOnceAfterPingTestPass) {
      return;
    }

    for(const site of sites) {
      const httpResult = await intfPlugin.checkHttpStatus(site);
      if (httpResult) {
        // keep bluetooth up if status code is 3xx
        if(httpResult.statusCode >= 300 && httpResult.statusCode < 400) {
          log.info(`looks like ${intfPlugin.name} has captive on, sending bluetooth control message...`);
          await pclient.publishAsync(Message.MSG_FIRERESET_BLUETOOTH_CONTROL, "1").catch((err) => {});
        }
        break;
      }
    }
  }
}

module.exports = WanConnCheckSensor;
