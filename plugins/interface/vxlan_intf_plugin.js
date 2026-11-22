/*    Copyright 2026 Firewalla Inc
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

// config keys under interface.vxlan.<name>:
//   vni      (required)  VXLAN Network Identifier
//   intf                 underlay interface the encap egresses (e.g. "br0")
//   local                underlay source IP
//   remote               peer underlay IP (unicast; mutually exclusive with group)
//   group                multicast group
//   dstport  (def 4789)  UDP destination port
class VXLANInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    await exec(`sudo modprobe vxlan`).catch((err) => {});
  }

  async flush() {
    await super.flush();

    if (this.networkConfig && this.networkConfig.enabled) {
      await exec(`sudo ip link set ${this.name} down`).catch((err) => {});
      await exec(`sudo ip link delete ${this.name}`).catch((err) => {});
    }
  }

  async createInterface() {
    const c = this.networkConfig;
    if (c.vni === undefined || c.vni === null) {
      this.fatal(`Missing vni for vxlan interface ${this.name}`);
    }
    let cmd = `sudo ip link add ${this.name} type vxlan id ${c.vni}`;
    if (c.intf) cmd += ` dev ${c.intf}`;
    if (c.local) cmd += ` local ${c.local}`;
    if (c.group) cmd += ` group ${c.group}`;
    else if (c.remote) cmd += ` remote ${c.remote}`;
    cmd += ` dstport ${c.dstport || 4789}`;
    await exec(cmd).catch((err) => {
      this.log.error(`Failed to create vxlan interface ${this.name}`, err.message);
    });

    // react to changes of the underlay interface when it is managed (mirrors vlan)
    if (c.intf) {
      const intfPlugin = pl.getPluginInstance("interface", c.intf);
      if (intfPlugin)
        this.subscribeChangeFrom(intfPlugin);
      else
        this.log.warn(`Underlay interface plugin not found for ${this.name}: ${c.intf}`);
    }
    return true;
  }

  getDefaultMTU() {
    // vxlan adds 50 bytes of encapsulation over IPv4 (1500 - 50)
    return 1450;
  }

  async getSubIntfs() {
    return this.networkConfig.intf ? [this.networkConfig.intf] : [];
  }

  isEthernetBasedInterface() {
    return true;
  }
}

module.exports = VXLANInterfacePlugin;
