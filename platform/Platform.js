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

  getWifiClientInterface() {
    return null;
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
    const confPath = `${srcDir}/${koName}.conf`;
    let changed = false;
    try {
      await exec(`cmp -s ${srcPath} ${dstPath}`);
    } catch (err) {
      try {
        // copy over <name>.conf (if any) and <name>.ko
        // NOTE: copy 2 files in same line to avoid harmless error from 1st command(NO .conf file)
        await exec(`sudo cp -f ${confPath} /etc/modprobe.d/; sudo cp -f ${srcPath} ${dstPath}`);
        // update kernel modules mapping
        await exec(`sudo depmod -a`);
        const koLoaded = await exec(`lsmod | fgrep -q ${koName}`).then( result => { return true;} ).catch((err)=>{return false;});
        log.debug(`koLoaded is ${koLoaded}`);
        if (koLoaded) {
          // reload kernel module
          await exec(`sudo modprobe -r ${koName}; sudo modprobe ${koName}`);
        }
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

  async setHardwareAddress(iface, hwAddr) {
    if(!hwAddr) {
      return; // by default don't reset back when hwAddr is undefined
    }

    log.info(`Setting ${iface} hwaddr to`, hwAddr);
    await exec(`sudo ip link set ${iface} address ${hwAddr}`).catch((err) => {
      log.error(`Failed to set hardware address of ${iface} to ${hwAddr}`, err.message);
    });
  }

  async resetHardwareAddress(iface) {
    const permAddr = await exec(`sudo ethtool -P ${iface} | awk '{print $3}'`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => {
      log.error(`Failed to get permanent address of ${iface}`, err.message);
      return null;
    });

    // 00:00:00:00:00:00 is invalid as a device mac addr
    if (permAddr && permAddr !== "00:00:00:00:00:00") {
      await exec(`sudo ip link set ${iface} address ${permAddr}`).catch((err) => {
        log.error(`Failed to revert hardware address of ${iface} to ${permAddr}`, err.message);
      });
    }
  }
}

module.exports = Platform;
