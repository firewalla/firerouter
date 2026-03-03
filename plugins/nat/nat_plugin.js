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

  constructor(name) {
    super(name);
    this._ip4s = [];
    this._ip6s = [];
  }

  isFlushNeeded(newConfig) {
    //no need to flush during config change, apply will handle the flush
    return false;
  }

  async _updateSNATRules(ips, oif, action, family = 4) {
    if (action !== 'add' && action !== 'del') {
      this.log.error(`Invalid action: must be 'add' or 'del', got ${action}`);
      return;
    }

    const cmd = family === 4 ? "iptables" : "ip6tables";
    const flag = action === 'add' ? '-A' : '-D';

    if (!_.isEmpty(ips)) {
      for (const ip of ips) {
        await exec(util.wrapIptables(`sudo ${cmd} -w -t nat ${flag} FR_SNAT -s ${ip} -o ${oif} -j MASQUERADE`)).catch((err) => { });
      }
    }
  }

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
      await this._updateSNATRules(this._ip4s, oif, "del");
      this._ip4s = [];

      if (this.networkConfig.ipv6) {
        await this._updateSNATRules(this._ip6s, oif, "del", 6);
        this._ip6s = [];
      }
    }

    if (NatPlugin.subnetsState[oif]) {
      const state = NatPlugin.subnetsState[oif];
      state.users.delete(this.name);
      if (state.users.size === 0) {
        await this._updateSNATRules(state.activeSubnets, oif, "del");
        state.activeSubnets = []; 
        delete NatPlugin.subnetsState[oif];
      }
    }
  }

  async apply() {
    if (!this.networkConfig) {
      this.fatal(`Network config of ${this.name} is not given.`);
      return;
    }

    const iif = this.networkConfig.in;
    const srcSubnets = this.networkConfig.srcSubnets || [];
    const oif = this.networkConfig.out;

    if ((!iif && _.isEmpty(srcSubnets)) || !oif) {
      this.fatal(`Missing iif/oif or srcSubnets/oif in config of ${this.name}`);
      return;
    }
    if (!NatPlugin.subnetsState[oif]) {
      NatPlugin.subnetsState[oif] = { users: new Set(), activeSubnets: [] };
    }
    const state = NatPlugin.subnetsState[oif];
    state.users.add(this.name);
    const globalToAdd = _.difference(srcSubnets, state.activeSubnets);
    const globalToDel = _.difference(state.activeSubnets, srcSubnets);

    state.activeSubnets = srcSubnets;

    await this._updateSNATRules(globalToAdd, oif, "add");
    await this._updateSNATRules(globalToDel, oif, "del");

    const iifPlugin = pl.getPluginInstance("interface", iif);

    if (iifPlugin) {
      this.subscribeChangeFrom(iifPlugin);

      if (!iifPlugin.networkConfig.enabled) {
        this.log.warn(`Interface ${iif} is not enabled`);
        // since interface is not enabled, we need to flush all the related SNAT rules
        await this.flush();
        return;
      }

      const ip4s = await iifPlugin.getIPv4Addresses();
      const newIp4s = _.difference(ip4s, this._ip4s);
      await this._updateSNATRules(newIp4s, oif, "add");
      
      const oldIp4s = _.difference(this._ip4s, ip4s);
      await this._updateSNATRules(oldIp4s, oif, "del");
      
      this._ip4s = ip4s || [];

      if (this.networkConfig.ipv6) {
        const ip6s = await iifPlugin.getRoutableIPv6Addresses();
        const newIp6s = _.difference(ip6s, this._ip6s);
        await this._updateSNATRules(newIp6s, oif, "add", 6);
        
        const oldIp6s = _.difference(this._ip6s, ip6s);
        await this._updateSNATRules(oldIp6s, oif, "del", 6);
        
        this._ip6s = ip6s || [];
      }
    } else if (iif) {
      this.log.error("Cannot find interface plugin " + iif);
    }
  }
}

// Stores the status of srcSubnets that are active for each WAN port.
// put here to compatibility with Node.js 10 on gold v1 u18
NatPlugin.subnetsState = {};

module.exports = NatPlugin;
