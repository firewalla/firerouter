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

const InterfaceBasePlugin = require('./intf_base_plugin.js');
const exec = require('child-process-promise').exec;
const pl = require('../plugin_loader.js');
const _ = require('lodash');

class BondInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    await exec("sudo modprobe bonding");
  }

  async flush() {
    await super.flush();
    if (this.networkConfig && this.networkConfig.enabled) {
      await exec(`sudo ip link set dev ${this.name} down`).catch((err) => {});
      if (!_.isEmpty(this.networkConfig.intf)) {
        // in rare cases, detachment will be deffered after bond is deleted, so explicitly detach slave interfaces here
        await exec(`sudo ifenslave -d ${this.name} ${this.networkConfig.intf.join(" ")}`).catch((err) => {});
      }
      await exec(`sudo ip link delete ${this.name}`).catch((err) => {});
      // some newer linux kernel will bring down slave interfaces of a bond if the bond is deleted
      for (const intf of this.networkConfig.intf) {
        await exec(`sudo ip link set ${intf} up`).catch((err) => {});
      }
    }
  }

  async createInterface() {
    const presentInterfaces = [];
    for (const intf of this.networkConfig.intf) {
      await exec(`sudo ip addr flush dev ${intf}`).catch((err) => {});
      const intfPlugin = pl.getPluginInstance("interface", intf);
      if (intfPlugin) {
        this.subscribeChangeFrom(intfPlugin);
        if (await intfPlugin.isInterfacePresent() === false) {
          this.log.warn(`Interface ${intf} is not present yet`);
          continue;
        }
        presentInterfaces.push(intf);
      } else {
        this.fatal(`Lower interface plugin is not found ${intf}`);
      }
    }

    // supported mode list: balance-rr, active-backup, balance-xor, broadcast, 802.3ad, balance-tlb, balance-alb
    // default to balance-rr
    const mode = this.networkConfig.mode || "balance-rr";
    await exec(`sudo ip link add ${this.name} type bond mode ${mode}`);
    if (presentInterfaces.length > 0)
      await exec(`sudo ifenslave ${this.name} ${presentInterfaces.join(" ")}`).catch((err) => {
        this.log.error(`Failed to add interfaces to bond ${this.name}`, err.message);
      });
    return true;
  }

  getDefaultMTU() {
    return 1500;
  }

  async getSubIntfs() {
    return this.networkConfig.intf;
  }

  isEthernetBasedInterface() {
    return true;
  }
}

module.exports = BondInterfacePlugin;