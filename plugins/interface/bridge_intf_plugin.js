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
const fsp = require('fs').promises;
const _ = require('lodash');

class BridgeInterfacePlugin extends InterfaceBasePlugin {

  isFlushNeeded(newConfig) {
    // flush is needed if attributes other than intf and stp are changed
    const c1 = _.pick(this.networkConfig, Object.keys(this.networkConfig).filter(k => k !== "intf" && k !== "stp"));
    const c2 = _.pick(newConfig, Object.keys(newConfig).filter(k => k !== "intf" && k !== "stp"));
    return !_.isEqual(c1, c2);
  }

  async flush() {
    await super.flush();
    if (this.networkConfig && this.networkConfig.enabled) {
      await exec(`sudo ip link set dev ${this.name} down`).catch((err) => {});
      await exec(`sudo brctl delbr ${this.name}`).catch((err) => {});
    }
  }

  async createInterface() {
    const presentInterfaces = [];
    for (const intf of this.networkConfig.intf) {
      await exec(`sudo ip addr flush dev ${intf}`).catch((err) => {});
      const intfPlugin = pl.getPluginInstance("interface", intf);
      if (intfPlugin) {
        // this is useful if it is a passthrough bridge
        this.subscribeChangeFrom(intfPlugin);
        if (await intfPlugin.isInterfacePresent() === false) {
          this.log.warn(`Interface ${intf} is not present yet`);
          continue;
        }
        presentInterfaces.push(intf);
      } else {
        this.fatal(`Lower interface plugin not found ${intf}`);
      }
    }

    await exec(`sudo brctl addbr ${this.name}`).catch((err) => {
      this.log.error(`Failed to create bridge interface ${this.name}`, err.message);
    });
    // default forward delay is 15 seconds, maybe too long
    await exec(`sudo brctl setfd ${this.name} 2.5`).catch((err) => {
      this.log.error(`Failed to change forward delay of bridge interface ${this.name}`, err.message);
    });
    // no need to enable stp if there is only one interface in bridge
    if (this.networkConfig.intf.length > 1) {
      // Spanning tree protocol is enabled by default
      await exec(`sudo brctl stp ${this.name} ${this.networkConfig.stp === false ? "off" : "on"}`).catch((err) => {
        this.log.error(`Failed to ${this.networkConfig.stp === false ? "disable" : "enable"} stp on bridge interface ${this.name}`, err.message);
      });
    }

    const existingIntf = await fsp.readdir(`/sys/class/net/${this.name}/brif`);
    for (const intf of existingIntf) {
      if (!presentInterfaces.includes(intf)) {
        await exec(`sudo brctl delif ${this.name} ${intf}`).catch((err) => {
          this.log.error(`Failed to remove interface ${intf} from bridge ${this.name}`, err.message);
        });
      }
    }

    if (presentInterfaces.length > 0)
      // add interfaces one at a time. Otherwise, if one interface cannot be added to bridge, the interfaces behind it will be skipped
      for (const iface of presentInterfaces) {
        await exec(`sudo brctl addif ${this.name} ${iface}`).catch((err) => {
          this.log.error(`Failed to add interface ${iface} to bridge ${this.name}`, err.message);
        })
      }
    return true;
  }

  getDefaultMTU() {
    return 1500;
  }
}

module.exports = BridgeInterfacePlugin;