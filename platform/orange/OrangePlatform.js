/*    Copyright 2021 Firewalla Inc.
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

const fsp = require('fs').promises;
const fs = require('fs');
const Platform = require('../Platform.js');
const _ = require('lodash');
const r = require('../../util/firerouter.js');
const firestatusBaseURL = "http://127.0.0.1:9966";
const exec = require('child-process-promise').exec;
const log = require('../../util/logger.js')(__filename);
const util = require('../../util/util.js');
const sensorLoader = require('../../sensors/sensor_loader.js');
const constants = require('../../util/constants.js');
const rclient = require('../../util/redis_manager.js').getRedisClient();
const AsyncLock = require('async-lock');
const lock = new AsyncLock();
const LOCK_INTF_INDEX = "LOCK_INTF_INDEX";
const ETH0_BASE = 0xffff4;
const ETH1_BASE = 0xffffa;
const LOCK_ETHERNET_RESET = "LOCK_ETHERNET_RESET";
const WLAN0_BASE = 0x4;

let errCounter = 0;
const maxErrCounter = 100; // do not try to set mac address again if too many errors.

const hostapdRestartTasks = {};

class OrangePlatform extends Platform {
  getName() {
    return "orange";
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/files/default_setup.json`;
  }

  async getWlanVendor() {
    return "mt7996e";
  }

  async getWpaCliBinPath() {
    return "wpa_cli";
  }

  async getWpaPassphraseBinPath() {
    return "wpa_passphrase";
  }

  async ledNormalVisibleStart() {
    await exec(`curl -s '${firestatusBaseURL}/fire?name=firerouter&type=normal_visible'`).catch( (err) => {
      log.error("Failed to set LED as WAN normal visible");
    });
  }

  async ledNormalVisibleStop() {
    await exec(`curl -s '${firestatusBaseURL}/resolve?name=firerouter&type=normal_visible'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAllNetworkDown() {
    await exec(`curl -s '${firestatusBaseURL}/fire?name=firerouter&type=network_down'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAnyNetworkUp() {
    await exec(`curl -s '${firestatusBaseURL}/resolve?name=firerouter&type=network_down'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async overrideEthernetKernelModule() {
    
  }

  async configEthernet() {
    await this.setEthernetOffload("eth1","sg","scatter-gather","on");
    await this.setEthernetOffload("eth1","tso","TCP segmentation offload","on");
    await this.setEthernetOffload("eth1","gso","generic segmentation offload","on");
  }

  async resetEthernet() {
    // unnecessary at the moment
    return;
    await lock.acquire(LOCK_ETHERNET_RESET, async () => {
      // Check if mtketh_reset file exists, check timestamp, and run reset if more than 15 minutes have passed
      const mtkethResetFile = "/dev/shm/mtketh_reset";
      const currentTime = Math.floor(Date.now() / 1000); // current time in seconds
      const coolDownSeconds = 30 * 60;

      let shouldReset = false;
      const fileExists = await fsp.access(mtkethResetFile, fs.constants.F_OK).then(() => true).catch(() => false);

      if (!fileExists) {
        shouldReset = true;
      } else {
        // Read timestamp from file
        const prevTs = await fsp.readFile(mtkethResetFile, {encoding: "utf8"}).catch(() => null);
        if (prevTs) {
          const lastResetTime = parseInt(prevTs.trim(), 10);
          if (!isNaN(lastResetTime) && (currentTime - lastResetTime) > coolDownSeconds) {
            shouldReset = true;
          }
        } else {
          // If we can't read the file, reset anyway
          shouldReset = true;
        }
      }

      if (shouldReset) {
        log.info("Resetting ethernet");
        // these commands will trigger workqueue work to reset the dma ring
        await exec(`sudo bash -c "echo 2 > /sys/kernel/debug/mtketh/reset; echo 1 > /sys/kernel/debug/mtketh/reset"`).catch((err) => {
          log.error("Failed to run mtketh reset commands", err.message);
        });
        // Record current timestamp in the file
        await fsp.writeFile(mtkethResetFile, currentTime.toString()).catch((err) => {
          log.error("Failed to write mtketh_reset file", err.message);
        });
      }
    }).catch((err) => {
      log.error("Failed to reset ethernet", err.message);
    });
  }

  getWifiClientInterface() {
    return "wlan0";
  }

  async overrideWLANKernelModule() {
  }

  _isPhysicalInterface(iface) {
    return ["eth0", "eth1"].includes(iface) || iface.startsWith("wlan");
  }

  // get interface permanent MAC address, only applicable to ethernet interfaces and wlan interfaces
  async getNativeAddress(iface, config) {
    if(!this._isPhysicalInterface(iface)) {
      return null;
    }
    switch (iface) {
      case "eth0": {
        const hexAddr = await this._getHexBaseAddress(ETH0_BASE);
        return hexAddr;
      }
      case "eth1": {
        const hexAddr = await this._getHexBaseAddress(ETH1_BASE);
        return hexAddr;
      }
      default: {
        return await this._getWLANAddress(iface, config.band);
      }
    }
  }

  getModelName() {
    return "Firewalla Orange";
  }

  // must kill ifplugd before changing orange mac address
  async setHardwareAddress(iface, hwAddr) {
    if(!this._isPhysicalInterface(iface)) {
      // for non-phy ifaces, use function from base class
      await super.setHardwareAddress(iface, hwAddr);
      return;
    }

    if(errCounter >= maxErrCounter) { // should not happen in production, just a self protection
      log.error("Skip set hardware address if too many errors on setting hardware address.");
      return;
    }

    if(hwAddr) {
      const activeMac = await this.getActiveMac(iface);
      if((activeMac && activeMac.toUpperCase()) === (hwAddr && hwAddr.toUpperCase())) {
        log.info(`Skip setting hwaddr of ${iface}, as it's already been configured.`);
        return;
      }
      await this._setHardwareAddress(iface, hwAddr);
    }
  }

  async _setHardwareAddress(iface, hwAddr) {
    log.info(`Setting ${iface} hwaddr to`, hwAddr);

    const ifplug = sensorLoader.getSensor("IfPlugSensor");
    if(ifplug) {
      await ifplug.stopMonitoringInterface(iface);
    }
    await exec(`sudo ip link set ${iface} down`);
    await exec(`sudo ip link set ${iface} address ${hwAddr}`).catch((err) => {
      log.error(`Failed to set hardware address of ${iface} to ${hwAddr}`, err.message);
      errCounter++;
    });
    await exec(`sudo ip link set ${iface} up`);
    if(ifplug) {
      await ifplug.startMonitoringInterface(iface);
    }
  }

  async resetHardwareAddress(iface, config) {
    if(!this._isPhysicalInterface(iface)) {
      // for non-phy ifaces, use function from base class
      await super.resetHardwareAddress(iface, config);
      return;
    }

    const activeMac = await this.getActiveMac(iface);
    const nativeMac = await this.getNativeAddress(iface, config);
    if(!nativeMac) {
      log.error("Unable to get native mac for iface", iface);
      return;
    }

    if ((activeMac && activeMac.toUpperCase()) !== (nativeMac && nativeMac.toUpperCase())) {
      if(errCounter >= maxErrCounter) { // should not happen in production, just a self protection
        log.error(`Skip set hwaddr of ${iface} if too many errors on setting hardware address.`);
        return;
      }

      log.info(`Resetting the hwaddr of ${iface} back to factory default:`, nativeMac);
      await this._setHardwareAddress(iface, nativeMac);
    } else {
      log.info(`no need to reset hwaddr of ${iface}, it's already resetted.`);
    }
  }

  async createWLANInterface(wlanIntfPlugin) {
    const macAddr = wlanIntfPlugin.networkConfig.hwAddr || await this._getWLANAddress(wlanIntfPlugin.name, wlanIntfPlugin.networkConfig.band);
    const phyName = await this._get80211PhyName();
    if (!phyName) {
      throw new Error("Failed to get 802.11 phy name");
    }
    if (!await wlanIntfPlugin.isInterfacePresent()) {
      await exec(`sudo iw phy ${phyName} interface add ${wlanIntfPlugin.name} type ${await this._getWLANInterfaceType(wlanIntfPlugin)}`);
    }
    await exec(`sudo ip link set ${wlanIntfPlugin.name} down`).catch((err) => {});
    await exec(`sudo ip link set ${wlanIntfPlugin.name} address ${macAddr}`).catch((err) => {});
  }

  async removeWLANInterface(wlanIntfPlugin) {
    await exec(`sudo iw dev ${wlanIntfPlugin.name} del`).catch((err) => {});
  }

  async _getWLANInterfaceType(wlanIntfPlugin) {
    if (wlanIntfPlugin.networkConfig.type)
      return wlanIntfPlugin.networkConfig.type;
    if (wlanIntfPlugin.name === this.getWifiClientInterface())
      return "managed";
    return "__ap";
  }

  async _get80211PhyName() {
    const phyNames = await fsp.readdir(`/sys/class/ieee80211/`);
    if (!_.isEmpty(phyNames))
      return phyNames[0];
    return null;
  }

  async _getWLANAddress(intfName, band) {
    // base is for wlan0, 2.4g uses base + 1, 5g uses base + 2s
    if (intfName === this.getWifiClientInterface()) {
      const addr = await this._getHexBaseAddress(WLAN0_BASE);
      return addr;
    } else {
      let offset = 0;
      if (band === "2.4g" || band == "2g") {
        offset = 1;
      } else if (band === "5g") {
        offset = 2;
      }
      let addr = await this._getHexOffsetAddress(WLAN0_BASE, offset);
      const idx = await this._allocateIntfIndex(intfName, band);
      if (idx > 0)
        addr += 0x040000000000 * idx + 0x020000000000;
      return addr.toString(16).padStart(12, "0").match(/.{1,2}/g).join(":").toUpperCase();
    }
  }

  async _getHexOffsetAddress(base, offset) {
    const baseAddress = await this._getHexBaseAddress(base);
    const addr = parseInt(baseAddress.split(":").join(""), 16)
    return addr + offset;
  }

  async _getHexBaseAddress(base) {
    let baseAddress = await rclient.getAsync(`base_mac_address:${base}`);
    if (!baseAddress) {
      baseAddress = await exec(`sudo xxd -u -p -l 6 -s ${base} /dev/mtdblock2`).then(result => result.stdout.trim().padStart(12, "0").match(/.{1,2}/g).join(":")).catch(() => {
        return null;
      });
      if (!baseAddress || !baseAddress.startsWith("20:6D:31")) {
        log.info(`Base address is invalid: ${baseAddress}, will generate a random base address.`);
        baseAddress = util.generateRandomMacAddress("20:6D:31");
      }
      await rclient.setAsync(`base_mac_address:${base}`, baseAddress);
    }
    return baseAddress;
  }

  // this function needs to be run sequentially
  async _allocateIntfIndex(intfName, band = "5g") {
    if (band == "2g")
      band = "2.4g";
    return await lock.acquire(LOCK_INTF_INDEX, async () => {
      let idx = await rclient.hgetAsync(`intf_index_hash:${band}`, intfName);
      if (idx) {
        const name = await rclient.hgetAsync(`index_intf_hash:${band}`, idx);
        if (name === intfName) {
          return idx;
        }
      }
      const pl = require('../../plugins/plugin_loader.js');
      for (let i = 0; i < 32; i++) {
        const name = await rclient.hgetAsync(`index_intf_hash:${band}`, i);
        if (!name || !pl.getPluginInstance("interface", name)) {
          await rclient.hsetAsync(`intf_index_hash:${band}`, intfName, i);
          await rclient.hsetAsync(`index_intf_hash:${band}`, i, intfName);
          return i;
        }
      }
      throw new Error("Failed to allocate interface index for " + intfName);
    });
  }

  isWLANManagedByAPC() {
    return true;
  }

  isHotplugSupported(intf) {
    const fixedIntfs = ["eth0", "eth1"];
    // all wlan interfaces are created by firerouter on orange, so they are not hotplug supported
    return !fixedIntfs.includes(intf) && !intf.startsWith("wlan");
  }

  isPDOSupported() {
    return true;
  }

  async loadPDOInfo() {
    const pdoInfoFile = `/dev/shm/pdo_info`;
    let pdoInfo = null;
    const fileExists = await fsp.access(pdoInfoFile, fs.constants.F_OK).then(() => true).catch(() => false);
    if (!fileExists) {
      const output = await exec(`sudo ${this.getFilesPath()}/get_pdo.sh`).then(result => result.stdout).catch(() => null);
      if (!output) {
        log.error("Failed to get PDO info from script");
        return {};
      }
      await fsp.writeFile(pdoInfoFile, output);
      pdoInfo = output;
    } else {
      pdoInfo = await fsp.readFile(pdoInfoFile, {encoding: "utf8"}).catch(() => null);
    }
    if (!pdoInfo) {
      log.error("Failed to get PDO info from file");
      return {};
    }
    const lines = pdoInfo.split("\n");
    const result = {};
    for (const line of lines) {
      const [key, value] = line.split("=");
      result[key] = value;
    }
    /* sample pdo info
    PDO_IDX=0
    VOLTAGE=11400
    CURRENT=150
    POWER_TYPE=Fixed
    */
    return result;
  }

  getEffectivePowerMode(pdoInfo, configuredPowerMode) {
    // limit to power save mode if PDO is not supported or maximum power is less than or equal to 15W
    if (!_.isObject(pdoInfo))
      return constants.POWER_MODE_POWERSAVE;
    if (!_.has(pdoInfo, 'PDO_IDX') || pdoInfo.PDO_IDX == 0)
      return constants.POWER_MODE_POWERSAVE;
    const voltage = pdoInfo.VOLTAGE;
    const current = pdoInfo.CURRENT;
    if (isNaN(voltage) || isNaN(current))
      return constants.POWER_MODE_POWERSAVE;
    if (Number(voltage) / 1000 * Number(current) / 1000 <= 15)
      return constants.POWER_MODE_POWERSAVE;
    // reach here if PDO is supported and maximum power is greater than 15W, if configured power mode is ondemand, use performance mode by default
    if ((configuredPowerMode || constants.POWER_MODE_ONDEMAND) === constants.POWER_MODE_ONDEMAND)
      return constants.POWER_MODE_PERFORMANCE;
    // otherwise use configured power mode
    return configuredPowerMode || constants.POWER_MODE_PERFORMANCE;
  }

  getWpaSupplicantGlobalDefaultConfig() {
    return {};
  }

  getWpaSupplicantNetworkDefaultConfig() {
    return {};
  }

  async _mergeHostapdConfig(band) {
    const files = await fsp.readdir(`${r.getUserConfigFolder()}/hostapd/band_${band}`).catch((err) => []);
    const bssConfigs = [];
    for (const file of files) {
      if (!file.endsWith(`.conf`)) {
        continue;
      }
      const intf = file.replace(".conf", "");
      const parameters = await fsp.readFile(`${r.getUserConfigFolder()}/hostapd/band_${band}/${file}`, {encoding: 'utf8'}).then(content => content.split("\n").reduce((result, line) => {
        const sepIdx = line.indexOf("=");
        if (sepIdx !== -1) {
          result[line.slice(0, sepIdx)] = line.slice(sepIdx + 1);
        }
        return result;
      }, {})).catch(() => ({}));
      delete parameters.interface;
      if (_.isEmpty(bssConfigs)) {
        bssConfigs.push(`interface=${intf}`);
      } else {
        bssConfigs.push(`bss=${intf}`);
        bssConfigs.push(`bssid=${await this._getWLANAddress(intf, band)}`);
      }
      for (const key of Object.keys(parameters)) {
        bssConfigs.push(`${key}=${parameters[key]}`);
      }
      bssConfigs.push("");
    }
    return bssConfigs;
  }

  async enableHostapd(iface, parameters) {
    const band = parameters.hw_mode === "g" ? "2.4g" : "5g";
    await fsp.writeFile(`${r.getUserConfigFolder()}/hostapd/band_${band}/${iface}.conf`, Object.keys(parameters).map(k => `${k}=${parameters[k]}`).join("\n"), {encoding: 'utf8'});
    this.scheduleHostapdRestart(band);
  }

  async disableHostapd(iface) {
    // this is just for backward compatibility, we don't need to stop firerouter_hostapd@${iface} in future releases
    await exec(`sudo systemctl stop firerouter_hostapd@${iface}`).catch((err) => {});
    for (const band of ["2.4g", "5g"]) {
      const files = await fsp.readdir(`${r.getUserConfigFolder()}/hostapd/band_${band}`).catch((err) => []);
      if (files.includes(`${iface}.conf`)) {
        await fsp.unlink(`${r.getUserConfigFolder()}/hostapd/band_${band}/${iface}.conf`).catch((err) => {});
        this.scheduleHostapdRestart(band);
        break;
      }
    }
  }

  scheduleHostapdRestart(band) {
    // use a timer to avoid restarting hostapd too frequently
    if (hostapdRestartTasks[band]) {
      clearTimeout(hostapdRestartTasks[band]);
    }
    hostapdRestartTasks[band] = setTimeout(async () => {
      const bssConfigs = await this._mergeHostapdConfig(band);
      if (_.isEmpty(bssConfigs)) {
        await fsp.unlink(`${r.getUserConfigFolder()}/hostapd/band_${band}.conf`).catch((err) => {});
        log.info(`Removed hostapd config on band ${band}, stopping hostapd service`);
        await exec(`sudo systemctl stop firerouter_hostapd@band_${band}`).catch((err) => {});
      } else {
        await fsp.writeFile(`${r.getUserConfigFolder()}/hostapd/band_${band}.conf`, bssConfigs.join("\n"), {encoding: 'utf8'});
        log.info(`Updated hostapd config on band ${band}, restarting hostapd service`);
        await exec(`sudo systemctl restart firerouter_hostapd@band_${band}`).catch((err) => {});
      }
    }, 3000);
  }
}

module.exports = OrangePlatform;
