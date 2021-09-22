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

const InterfaceBasePlugin = require('./intf_base_plugin.js');

const exec = require('child-process-promise').exec;

const routing = require('../../util/routing.js');

class GenericTunInterfacePlugin extends InterfaceBasePlugin {

  async flush() {
    await super.flush();
    await exec(`sudo ip link set ${this.name} down`).catch((err) => {});
    await exec(`sudo ip link del dev ${this.name}`).catch((err) => {});
  }

  async prepareEnvironment() {
    await super.prepareEnvironment();

    if ("rp_filter" in this.networkConfig) {
      await exec(`sudo sysctl -w net.ipv4.conf.${this.name}.rp_filter=${this.networkConfig.rp_filter}`);
    }

    if ("all_rp_filter" in this.networkConfig) {
      await exec(`sudo sysctl -w net.ipv4.conf.all.rp_filter=${this.networkConfig.all_rp_filter}`);
    }
  }

  async createInterface() {
    const user = this.networkConfig.user || "pi";
    await exec(`ip a show ${this.name} || sudo ip tuntap add mode tun user ${user} name ${this.name}`).catch((err) => {
      this.log.error(`Failed to create interface ${this.name}, err:`, err);
    }); // catch the error as it's likely not to be critical
    return true;
  }

  async changeRoutingTables() {
    await super.changeRoutingTables();
    await routing.addRouteToTable("default", null, this.name, `${this.name}_default`, null)
  }
}

module.exports = GenericTunInterfacePlugin;