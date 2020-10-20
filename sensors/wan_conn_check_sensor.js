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
      let active = true;
      const extraConf = wanIntfPlugin && wanIntfPlugin.networkConfig && wanIntfPlugin.networkConfig.extra;
      let pingTestIP = (extraConf && extraConf.pingTestIP) || defaultPingTestIP;
      let pingTestCount = (extraConf && extraConf.pingTestCount) || defaultPingTestCount;
      if (_.isString(pingTestIP))
        pingTestIP = [pingTestIP];
      if (pingTestIP.length > 3) {
        this.log.warn(`Number of ping test target is greater than 3 on ${wanIntfPlugin.name}, will only use the first 3 for testing`);
        pingTestIP = pingTestIP.slice(0, 3);
      }
      const pingSuccessRate = (extraConf && extraConf.pingSuccessRate) || defaultPingSuccessRate;
      const dnsTestDomain = (extraConf && extraConf.dnsTestDomain) || defaultDnsTestDomain;
      const forceState = (extraConf && extraConf.forceState) || undefined;
      await Promise.all(pingTestIP.map(async (ip) => {
        let cmd = `ping -n -q -I ${wanIntfPlugin.name} -c ${pingTestCount} -i 1 ${ip} | grep "received" | awk '{print $4}'`;
        return exec(cmd).then((result) => {
          if (!result || !result.stdout || Number(result.stdout.trim()) < pingTestCount * pingSuccessRate) {
            this.log.error(`Failed to pass ping test to ${ip} on ${wanIntfPlugin.name}`);
            return false;
          } else
            return true;
        }).catch((err) => {
          this.log.error(`Failed to do ping test to ${ip} on ${wanIntfPlugin.name}`, err.message);
          return false;
        });
      })).then(results => {
        if (!results.some(result => result === true)) {
          this.log.error(`Ping test failed to all ping test targets on ${wanIntfPlugin.name}`);
          active = false;
        }
      });
      if (active) {
        const nameservers = await wanIntfPlugin.getDNSNameservers();
        if (_.isArray(nameservers) && nameservers.length !== 0) {
          const nameserver = nameservers[0];
          const cmd = `dig -4 +short +time=3 +tries=2 @${nameserver} ${dnsTestDomain}`;
          await exec(cmd).then((result) => {
            if (!result || !result.stdout || result.stdout.trim().length === 0) {
              this.log.error(`Failed to resolve ${dnsTestDomain} using ${nameserver} on ${wanIntfPlugin.name}`);
              active = false;
            }
          }).catch((err) => {
            this.log.error(`Failed to do DNS test using ${nameserver} on ${wanIntfPlugin.name}`, err.message);
            active = false;
          });
        }
      }

      const e = event.buildEvent(event.EVENT_WAN_CONN_CHECK, {intf: wanIntfPlugin.name, active: active, forceState: forceState});
      event.suppressLogging(e);
      wanIntfPlugin.propagateEvent(e);
    }));
  }
}

module.exports = WanConnCheckSensor;