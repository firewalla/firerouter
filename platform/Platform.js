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

const log = require('../util/logger.js')(__filename);
const fsp = require('fs').promises
const r = require('../util/firerouter')
const exec = require('child-process-promise').exec;

class Platform {
  getName() {
  }

  getType() {
  }

  async getLSBCodeName() {
    return await exec("lsb_release -cs", {encoding: 'utf8'}).then(result=> result.stdout.trim()).catch((err)=>{
      log.error("failed to get codename from lsb_release:",err.message);
    });
  }

  async isUbuntu20() {
    return await this.getLSBCodeName() === 'focal';
  }

  async isUbuntu22() {
    return await this.getLSBCodeName() === 'jammy';
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

  async getWpaCliBinPath() {
    return null;
  }

  async getWpaPassphraseBinPath() {
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

  async kernelModuleLoaded(name) {
    return exec(`lsmod | fgrep -q ${name}`).then(()=>true).catch(()=>false);
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
        const koLoaded = await this.kernelModuleLoaded(koName)
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

  clearMacCache(iface) {

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

  async installWLANTools() {
  }

  getModelName() {
    return "";
  }

  async getActiveMac(iface) {
    return fsp.readFile(`/sys/class/net/${iface}/address`, {encoding: 'utf8'})
      .then(result => result.trim().toUpperCase())
      .catch(() => "")
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

  async installMiniupnpd() {
    // replace miniupnpd binary if it is using nftables backend,
    // nft-based miniupnpd will create separate table for its chains, need to use in-house miniupnpd to make it use existing chains in filter table
    const nftUsed = await exec(`ldd $(which miniupnpd) | grep libnftnl`).then(() => true).catch((err) => false);
    const ubtVersionDir = await this.isUbuntu22() ? "u22" : (await this.isUbuntu20() ? "u20" : ".");
    if (nftUsed) {
      log.info(`miniupnpd is using nftables, will replace it with in-house miniupnpd ...`);
      await exec(`sudo cp -f ${this.getBinaryPath()}/${ubtVersionDir}/miniupnpd.nft $(which miniupnpd)`).catch((err) => {
        log.error(`Failed to update miniupnpd with nft support`, err.message);
      });
    }
  }
}

module.exports = Platform;
