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
const pl = require('../plugins/plugin_loader.js');

const APSafeFreqs = [
  2412, 2417, 2422, 2427, 2432, 2437, 2442, 2447, 2452, 2457, 2462, // NO_IR: 2467, 2472,
  5180, 5200, 5220, 5240, 5745, 5765, 5785, 5805, 5825,
]

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

  getFilesPath() {
    return `${r.getFireRouterHome()}/platform/${this.getName()}/files`;
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

  async reloadKernelModule(koName,srcDir,forceReload=false) {
    const srcPath = `${srcDir}/${koName}.conf`;
    const dstPath = `/etc/modprobe.d/${koName}.conf`;
    let koReloaded = false;
    let confChanged = false;
    try {
      await exec(`cmp -s ${srcPath} ${dstPath}`);
      log.debug(`kernel module ${koName} reload - bypassed due to configuration already up-to-date in ${dstPath}`)
    } catch (err) {
      confChanged = true;
      // copy over .conf
      await exec(`sudo cp -f ${srcPath} ${dstPath}`);
      log.info(`kernel module ${koName} reload - configuration updated in ${dstPath}`);
      // update kernel modules mapping
      await exec(`sudo depmod -a`);
      log.debug(`kernel module ${koName} reload - kernel modules mapping updated`);
    }
    if (confChanged || forceReload) try {
      const koLoaded = await this.kernelModuleLoaded(koName);
      log.debug(`kernel module ${koName} reload - kernel module previously loaded(${koLoaded})`);
      if (koLoaded || forceReload ) {
        // reload kernel module
        await exec(`sudo modprobe -r ${koName}; sudo modprobe ${koName}`);
        koReloaded = true;
      }
      log.info(`kernel module ${koName} reload - kernel module just reloaded(${koReloaded})`);
    } catch(err) {
      log.error(`Failed to reload kernel module ${koName}:`,err);
    }
    return koReloaded;
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

  async reloadWLANKernelModule() {
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
      await exec(`sudo cp -f --preserve=mode ${this.getBinaryPath()}/${ubtVersionDir}/miniupnpd.nft $(which miniupnpd)`).catch((err) => {
        log.error(`Failed to update miniupnpd with nft support`, err.message);
      });
    }
  }

  async toggleEthernetLed(iface, flag) {

  }

  async setMTU(iface, mtu) {
    await exec(`sudo ip link set ${iface} mtu ${mtu}`).catch((err) => {
      log.error(`Failed to set MTU of ${iface} to ${mtu}`, err.message);
    });
  }

  async createWLANInterface(wlanIntfPlugin) {
    const ifaceExists = await exec(`ip link show dev ${wlanIntfPlugin.name}`).then(() => true).catch((err) => false);
    if (!ifaceExists) {
      if (wlanIntfPlugin.networkConfig.baseIntf) {
        const baseIntf = wlanIntfPlugin.networkConfig.baseIntf;
        const baseIntfPlugin = pl.getPluginInstance("interface", baseIntf);
        if (baseIntfPlugin) {
          wlanIntfPlugin.subscribeChangeFrom(baseIntfPlugin);
          if (await baseIntfPlugin.isInterfacePresent() === false) {
            wlanIntfPlugin.log.warn(`Base interface ${baseIntf} is not present yet`);
            return false;
          }
        } else {
          wlanIntfPlugin.fatal(`Lower interface plugin not found ${baseIntf}`);
        }
        const type = wlanIntfPlugin.networkConfig.type || "managed";
        await exec(`sudo iw dev ${baseIntf} interface add ${wlanIntfPlugin.name} type ${type}`);
      }
    } else {
      wlanIntfPlugin.log.warn(`Interface ${wlanIntfPlugin.name} already exists`);
    }
  }

  async removeWLANInterface(wlanIntfPlugin) {
    if (wlanIntfPlugin.networkConfig && wlanIntfPlugin.networkConfig.baseIntf) {
      const baseIntf = wlanIntfPlugin.networkConfig.baseIntf;
      const basePhy = await exec(`readlink -f /sys/class/net/${baseIntf}/phy80211`, {encoding: "utf8"}).then(result => result.stdout.trim()).catch((err) => null);
      const myPhy = await exec(`readlink -f /sys/class/net/${wlanIntfPlugin.name}/phy80211`, {encoding: "utf8"}).then(result => result.stdout.trim()).catch((err) => null);
      if (basePhy && myPhy && basePhy === myPhy)
        await exec(`sudo iw dev ${wlanIntfPlugin.name} del`).catch((err) => {});
      else
        wlanIntfPlugin.log.warn(`${wlanIntfPlugin.name} and ${baseIntf} are not pointing to the same wifi phy, interface ${wlanIntfPlugin.name} will not be deleted`);
    }
  }

  isWLANManagedByAPC() {
    return false;
  }

  isHotplugSupported(intf) {
    return true;
  }

  isPDOSupported() {
    return false;
  }

  async loadPDOInfo() {
  }

  getEffectivePowerMode(pdoInfo, configuredPowerMode) {
  }

  getWpaSupplicantGlobalDefaultConfig() {
    return {
      bss_expiration_age: 630,
      bss_expiration_scan_count: 5,

      // sets freq_list globally limits the frequencies being scaned
      freq_list: APSafeFreqs,
      pmf: 1,
    }
  }

  getWpaSupplicantNetworkDefaultConfig() {
    return {
      // sets freq_list again on each network limits the frequencies being used for connection
      freq_list: APSafeFreqs,
    }
  }

  async enableHostapd(iface, parameters) {
    await fsp.writeFile(`${r.getUserConfigFolder()}/hostapd/${iface}.conf`, Object.keys(parameters).map(k => `${k}=${parameters[k]}`).join("\n"), {encoding: 'utf8'});
    await exec(`sudo systemctl restart firerouter_hostapd@${iface}`).catch((err) => {});
  }

  async disableHostapd(iface) {
    await exec(`sudo systemctl stop firerouter_hostapd@${iface}`).catch((err) => {});
    await fsp.unlink(`${r.getUserConfigFolder()}/hostapd/${iface}.conf`).catch((err) => {});
  }
}

module.exports = Platform;
