/*    Copyright 2020-2026 Firewalla Inc.
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
const { execFile } = require('child-process-promise');
const pl = require('../plugin_loader.js');
const _ = require('lodash');

class BondInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    await execFile("sudo", ["modprobe", "bonding"]);
  }

  async flush() {
    await super.flush();
    if (this.networkConfig && this.networkConfig.enabled) {
      await execFile("sudo", ["ip", "link", "set", "dev", this.name, "down"]).catch((err) => {});
      if (!_.isEmpty(this.networkConfig.intf)) {
        // in rare cases, detachment will be deffered after bond is deleted, so explicitly detach slave interfaces here
        await execFile("sudo", ["ifenslave", "-d", this.name].concat(this.networkConfig.intf)).catch((err) => {});
      }
      await execFile("sudo", ["ip", "link", "delete", this.name]).catch((err) => {});
      // some newer linux kernel will bring down slave interfaces of a bond if the bond is deleted
      for (const intf of this.networkConfig.intf) {
        await execFile("sudo", ["ip", "link", "set", intf, "up"]).catch((err) => {});
      }
    }
  }

  // returns networkConfig[field] if it is in the supported list, otherwise the fallback. for fields
  // that are interpolated into a command, so they are held to what the driver documents
  _supportedOrDefault(field, supported, fallback) {
    const value = this.networkConfig[field];
    if (supported.includes(value))
      return value;
    if (value)
      this.log.error(`Unsupported bond ${field} for ${this.name}, using ${fallback}`, value);
    return fallback;
  }

  async createInterface() {
    const presentInterfaces = [];
    for (const intf of this.networkConfig.intf) {
      await execFile("sudo", ["ip", "addr", "flush", "dev", intf]).catch((err) => {});
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
    // default to balance-rr. mode is interpolated into the command below, so enforce that list
    const supportedModes = ["balance-rr", "active-backup", "balance-xor", "broadcast", "802.3ad", "balance-tlb", "balance-alb"];
    const mode = this._supportedOrDefault("mode", supportedModes, "balance-rr");
    await execFile("sudo", ["ip", "link", "add", this.name, "type", "bond", "mode", mode]).catch((err) => {
      this.log.debug(`Failed to create bond interface ${this.name} with mode ${mode}`, err.message);
    });
    if (presentInterfaces.length > 0) {
      // detach slave interfaces and add them back to ensure the MAC address of slave interfaces is updated after interface is re-added
      await execFile("sudo", ["ifenslave", "-d", this.name].concat(presentInterfaces)).catch((err) => {
        this.log.debug(`Failed to detach interfaces from bond ${this.name}`, err.message);
      });
      await execFile("sudo", ["ifenslave", this.name].concat(presentInterfaces)).catch((err) => {
        this.log.error(`Failed to add interfaces to bond ${this.name}`, err.message);
      });
    }
    return true;
  }

  getDefaultMTU() {
    return 1500;
  }

  async getSubIntfs() {
    return this.networkConfig.intf;
  }

  async getActiveIntfs() {
    if (!this.networkConfig || _.isEmpty(this.networkConfig.intf))
      return [];
    const states = await Promise.all(this.networkConfig.intf.map(intf => this._getSysFSClassNetValueOf(intf, "bonding_slave/state")));
    return this.networkConfig.intf.filter((intf, i) => states[i] === "active");
  }

  isEthernetBasedInterface() {
    return true;
  }
}

module.exports = BondInterfacePlugin;
