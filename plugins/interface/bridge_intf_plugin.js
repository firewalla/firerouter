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
    // flush is needed if attributes other than stp are changed
    const c1 = _.pick(this.networkConfig, Object.keys(this.networkConfig).filter(k => k !== "stp"));
    const c2 = _.pick(newConfig, Object.keys(newConfig).filter(k => k !== "stp"));
    return !_.isEqual(c1, c2);
  }

  async flush() {
    await super.flush();
    if (this.networkConfig && this.networkConfig.enabled) {
      await exec(`sudo ip link set dev ${this.name} down`).catch((err) => {});
      await exec(`sudo brctl stp ${this.name} off`).catch((err) => {});
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
      this.log.debug(`Failed to create bridge interface ${this.name}`, err.message);
    });

    const isVlanBridge = this.networkConfig.intf.every(i => i.includes('.'));
    if (this.networkConfig.intf.length > 1 && !isVlanBridge) {
      // start mstpd if not already running; no-op if already active
      await exec(`sudo systemctl start firerouter_mstpd`).catch((err) => {
        this.log.warn(`Failed to start mstpd service`, err.message);
      });
      if (this.networkConfig.stp !== false) {
        // a bridge left at stp_state=1 (kernel STP) by a previous firerouter version would silently stay at 1 
        // instead of transitioning to stp_state=2 (BR_USER_STP).
        await exec(`sudo brctl stp ${this.name} off`).catch((err) => {});
        // brctl stp on causes the kernel to invoke /sbin/bridge-stp, which calls mstpctl addbridge
        // and returns exit 0, so the kernel automatically sets stp_state=2 (BR_USER_STP).
        await exec(`sudo brctl stp ${this.name} on`).catch((err) => {
          this.log.error(`Failed to enable STP on ${this.name}`, err.message);
        });
      } else {
        // brctl stp off invokes /sbin/bridge-stp stop → mstpctl delbridge, stp_state=0
        await exec(`sudo brctl stp ${this.name} off`).catch((err) => {});
      }
    } else {
      // VLAN bridges should always have STP disabled; clear any stale kernel STP state
      await exec(`sudo brctl stp ${this.name} off`).catch((err) => {});
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
        if (existingIntf.includes(iface))
          continue;
        await exec(`sudo brctl addif ${this.name} ${iface}`).catch((err) => {
          this.log.error(`Failed to add interface ${iface} to bridge ${this.name}`, err.message);
        })
      }
    return true;
  }

  getDefaultMTU() {
    return 1500;
  }

  async getSubIntfs() {
    // return runtime lower interfaces from sysfs brif directory, the effective config may be different from the frcc config due to integrated AP config
    const brifs = await fsp.readdir(`/sys/class/net/${this.name}/brif`).catch((err) => {
      this.log.error(`Failed to read brif of bridge ${this.name}`, err.message);
      return null;
    });
    return brifs;
  }

  isEthernetBasedInterface() {
    return true;
  }

  static async preparePlugin() {
    await super.preparePlugin();
    const r = require('../../util/firerouter.js');
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/firerouter_mstpd.service /etc/systemd/system/`);
    await exec(`sudo install -m 755 ${r.getFireRouterHome()}/scripts/bridge-stp.sh /sbin/bridge-stp`);
  }
}

module.exports = BridgeInterfacePlugin;
