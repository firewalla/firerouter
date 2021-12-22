/*    Copyright 2016-2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
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

const fs = require('fs');
const log = require('../util/logger.js')(__filename);
const r = require('../util/firerouter')
const exec = require('child-process-promise').exec;
const Promise = require('bluebird');
Promise.promisifyAll(fs);

class Platform {
  getName() {
  }

  getType() {
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/../network/default_setup.json`;
  }

  async getWlanVendor() {
    return '';
  }

  getWpaCliBinPath() {
    return null;
  }

  getBinaryPath() {
    return `${r.getFireRouterHome()}/platform/${this.getName()}/bin`;
  }

  async ledNormalVisibleStart() {
  }

  async ledNormalVisibleStop() {
  }

  async ledAllNetworkDown() {
  }

  async ledAnyNetworkUp() {
  }

  async overrideKernelModule(koName,srcDir,dstDir) {
    const srcPath = `${srcDir}/${koName}.ko`;
    const dstPath = `${dstDir}/${koName}.ko`;
    let changed = false;
    try {
      await exec(`cmp -s ${srcPath} ${dstPath}`);
    } catch (err) {
      try {
        await exec(`sudo cp -f ${srcPath} ${dstPath}`);
        await exec(`sudo modprobe -r ${koName}; sudo modprobe ${koName}`);
        changed = true;
      } catch(err) {
        log.error(`Failed to override kernel module ${koName}:`,err);
      }
    }
    return changed;
  }

  async overrideEthernetKernelModule() {
  }

  async setEthernetOffload(iface,feature,desc,onoff) {
    await exec(`sudo ethtool -K ${iface} ${feature} ${onoff}`).catch( (err) => {
      log.error(`Failed to turn ${onoff} ${desc} in ${iface}`);
    });
  }

  async configEthernet() {
  }

  async overrideWLANKernelModule() {
  }

  getModelName() {
    return "";
  }
}

module.exports = Platform;
