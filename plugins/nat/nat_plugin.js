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

class NatPlugin extends Plugin {

  async flush() {
    if (!this.networkConfig) {
      this.log.error(`Network config of ${this.name} is not given.`);
      return;
    }

    const iif = this.networkConfig.in;
    const oif = this.networkConfig.out;

    if (!iif || !oif) {
      this.log.error(`Invalid config of ${this.name}`, this.networkConfig);
      return;
    }

    const iifPlugin = pl.getPluginInstance("interface", iif);
    if (iifPlugin) {
      const state = await iifPlugin.state();
      if (state && state.ip4) {
        await exec(util.wrapIptables(`sudo iptables -w -t nat -D FR_SNAT -s ${state.ip4} -o ${oif} -j MASQUERADE`));
      } else {
        this.log.error("Failed to get ip4 of incoming interface " + iif);
      }
    }
  }

  async apply() {
    if (!this.networkConfig) {
      this.fatal(`Network config of ${this.name} is not given.`);
      return;
    }

    const iif = this.networkConfig.in;
    const oif = this.networkConfig.out;

    if (!iif || !oif) {
      this.fatal(`Missing in/out interface in config of ${this.name}`);
      return;
    }

    const iifPlugin = pl.getPluginInstance("interface", iif);
    if (iifPlugin) {
      this.subscribeChangeFrom(iifPlugin);
      const state = await iifPlugin.state();
      if (state && state.ip4) {
        await exec(util.wrapIptables(`sudo iptables -w -t nat -A FR_SNAT -s ${state.ip4} -o ${oif} -j MASQUERADE`));
      } else {
        this.fatal("Failed to get ip4 of incoming interface " + iif);
      }
    } else {
      this.log.error("Cannot find interface plugin " + iif);
    }
  }
}

module.exports = NatPlugin;
