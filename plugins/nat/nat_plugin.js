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

const Plugin = require('../plugin.js');
const exec = require('child-process-promise').exec;
const util = require('../../util/util.js');
const pl = require('../plugin_loader.js');
const _  = require('lodash');

class NatPlugin extends Plugin {

  async flush() {
    if (!this.networkConfig) {
      this.log.error(`Network config of ${this.name} is not given.`);
      return;
    }

    const iif = this.networkConfig.in;
    const srcSubnets = this.networkConfig.srcSubnets;
    const oif = this.networkConfig.out;

    if ((!iif && !srcSubnets) || !oif) {
      this.log.error(`Invalid config of ${this.name}`, this.networkConfig);
      return;
    }

    const iifPlugin = pl.getPluginInstance("interface", iif);
    if (iifPlugin) {
      const ip4s = this._ip4s;
      if (!_.isEmpty(ip4s)) {
        for (const ip4 of ip4s) {
          await exec(util.wrapIptables(`sudo iptables -w -t nat -D FR_SNAT -s ${ip4} -o ${oif} -j MASQUERADE`));
        }
      } else {
        this.log.error("Failed to get ip4 of incoming interface " + iif);
      }
      if (this.networkConfig.ipv6) {
        const ip6s = this._ip6s;
        if (!_.isEmpty(ip6s)) {
          for (const ip6 of ip6s) {
            await exec(util.wrapIptables(`sudo ip6tables -w -t nat -D FR_SNAT -s ${ip6} -o ${oif} -j MASQUERADE`));
          }
        } else {
          this.log.error("Failed to get ip6 of incoming interface " + iif);
        }
      }
    }

    if (srcSubnets) {
      for (const srcSubnet of srcSubnets) {
        await exec(util.wrapIptables(`sudo iptables -w -t nat -D FR_SNAT -s ${srcSubnet} -o ${oif} -j MASQUERADE`));
      }
    }
  }

  async apply() {
    if (!this.networkConfig) {
      this.fatal(`Network config of ${this.name} is not given.`);
      return;
    }

    const iif = this.networkConfig.in;
    const srcSubnets = this.networkConfig.srcSubnets;
    const oif = this.networkConfig.out;

    if ((!iif && !srcSubnets) || !oif) {
      this.fatal(`Missing iif/oif or srcSubnets/oif in config of ${this.name}`);
      return;
    }

    const iifPlugin = pl.getPluginInstance("interface", iif);
    if (iifPlugin) {
      this.subscribeChangeFrom(iifPlugin);
      if (!iifPlugin.networkConfig.enabled) {
        this.log.warn(`Interface ${iif} is not enabled`);
        return;
      }
      const ip4s = await iifPlugin.getIPv4Addresses();
      if (!_.isEmpty(ip4s)) {
        for (const ip4 of ip4s) {
          await exec(util.wrapIptables(`sudo iptables -w -t nat -A FR_SNAT -s ${ip4} -o ${oif} -j MASQUERADE`));
        }
      } else {
        this.log.error("Failed to get ip4 of incoming interface " + iif);
      }
      this._ip4s = ip4s;
      if (this.networkConfig.ipv6) {
        const ip6s = await iifPlugin.getRoutableIPv6Addresses();
        if (!_.isEmpty(ip6s)) {
          for (const ip6 of ip6s) {
            await exec(util.wrapIptables(`sudo ip6tables -w -t nat -A FR_SNAT -s ${ip6} -o ${oif} -j MASQUERADE`));
          }
        } else {
          this.log.error("Failed to get ip6 of incoming interface " + iif);
        }
        this._ip6s = ip6s;
      }
    } else {
      this.fatal("Cannot find interface plugin " + iif);
    }

    if (srcSubnets) {
      for (const srcSubnet of srcSubnets) {
        await exec(util.wrapIptables(`sudo iptables -w -t nat -A FR_SNAT -s ${srcSubnet} -o ${oif} -j MASQUERADE`));
      }
    }
  }
}

module.exports = NatPlugin;