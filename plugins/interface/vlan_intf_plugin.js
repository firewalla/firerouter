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

const InterfaceBasePlugin = require('./intf_base_plugin.js');

const exec = require('child-process-promise').exec;
const pl = require('../plugin_loader.js');

class VLANInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    await exec(`sudo modprobe 8021q`);
  }
  
  async flush() {
    await super.flush();

    if (this.networkConfig && this.networkConfig.enabled) {
      await exec(`sudo ip link set ${this.name} down`).catch((err) => {});
      await exec(`sudo vconfig rem ${this.name}`).catch((err) => {});
    }
  }

  async createInterface() {
    const intf = this.networkConfig.intf;
    const vid = this.networkConfig.vid;
    await exec(`sudo vconfig add ${intf} ${vid}`).catch((err) => {
      this.log.error(`Failed to create vlan interface ${this.name}`, err.message);
    });
    const intfPlugin = pl.getPluginInstance("interface", this.networkConfig.intf);
    if (intfPlugin) {
      this.subscribeChangeFrom(intfPlugin);
    } else {
      this.fatal(`Lower interface plugin not found ${this.networkConfig.intf}`);
    }
  }
}

module.exports = VLANInterfacePlugin;