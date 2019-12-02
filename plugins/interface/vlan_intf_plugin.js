/*    Copyright 2019 Firewalla, Inc
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

const log = require('../../util/logger.js')(__filename);

const PhyInterfacePlugin = require('./phy_intf_plugin.js');

const exec = require('child-process-promise').exec;
const routing = require('../../util/routing.js');
const ip = require('ip');

class VLANInterfacePlugin extends PhyInterfacePlugin {
  
  async flush() {
    await super.flush();

    if (this.networkConfig && this.networkConfig.enabled) {
      await exec(`sudo ip link set ${this.name} down`).catch((err) => {});
      await exec(`sudo vconfig rem ${this.name}`).catch((err) => {});
    }
  }

  async prepareEnvironment() {
    const vid = this.networkConfig.vid;
    const intf = this.networkConfig.intf;
    await exec(`sudo vconfig add ${intf} ${vid}`).catch((err) => {
      log.error(`Failed to create vlan interface ${this.name}`, err.message);
    });
    await exec(`sudo ip link set ${this.name} up`).catch((err) => {
      log.error(`Failed to bring up vlan interface ${this.name}`, err.message);
    });
    await super.prepareEnvironment();
  }
}

module.exports = VLANInterfacePlugin;