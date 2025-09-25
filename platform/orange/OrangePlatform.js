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
const firestatusBaseURL = "http://127.0.0.1:9966";
const exec = require('child-process-promise').exec;
const log = require('../../util/logger.js')(__filename);
const util = require('../../util/util.js');
const sensorLoader = require('../../sensors/sensor_loader.js');
const constants = require('../../util/constants.js');
const rclient = require('../../util/redis_manager.js').getRedisClient();

const macCache = {};

let errCounter = 0;
const maxErrCounter = 100; // do not try to set mac address again if too many errors.

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

  getWifiClientInterface() {
    return "wlan0";
  }

  getWifiAPInterface() {
    return "wlan1";
  }

  async overrideWLANKernelModule() {
  }

  clearMacCache(iface) {
    if (macCache[iface])
      delete macCache[iface];
  }

  _isPhysicalInterface(iface) {
    return ["eth0", "eth1"].includes(iface) || iface.startsWith("wlan");
  }

  async getMacByIface(iface) {
    if(!this._isPhysicalInterface(iface)) {
      return null;
    }

    if(macCache[iface]) {
      return macCache[iface];
    }

    const mac = await this._getMacByIface(iface);
    macCache[iface] = mac;
    return mac;
  }

  async _getMacByIface(iface) {
    switch(iface) {
      case "eth0":
        return await this.getMac(0);
      case "eth1":
        return await this.getMac(1);
      case "wlan0":
        return await this.getMac(2);
      case "wlan1":
        return await this.getMac(3);
    }

    return;
  }

  async getMac(index) {
    const mac = await exec(`seq 0 5 | xargs -I ZZZ -n 1 sudo i2cget -y 1 0x50 0x${index}ZZZ | cut -d 'x' -f 2 | paste -sd ':'`)
          .then(result => result.stdout.trim())
          .catch((err) => {
            log.error(`Failed to get MAC address for index ${index} from EPROM`, err.message);
            return "";
          });
    return mac.toUpperCase();
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

  async resetHardwareAddress(iface) {
    if(!this._isPhysicalInterface(iface)) {
      // for non-phy ifaces, use function from base class
      await super.resetHardwareAddress(iface);
      return;
    }

    const activeMac = await this.getActiveMac(iface);
    const eepromMac = await this.getMacByIface(iface);
    if(!eepromMac) {
      log.error("Unable to get eeprom mac for iface", iface);
      return;
    }

    if ((activeMac && activeMac.toUpperCase()) !== (eepromMac && eepromMac.toUpperCase())) {
      if(errCounter >= maxErrCounter) { // should not happen in production, just a self protection
        log.error(`Skip set hwaddr of ${iface} if too many errors on setting hardware address.`);
        return;
      }

      log.info(`Resetting the hwaddr of ${iface} back to factory default:`, eepromMac);
      await this._setHardwareAddress(iface, eepromMac);
    } else {
      log.info(`no need to reset hwaddr of ${iface}, it's already resetted.`);
    }
  }

  async createWLANInterface(wlanIntfPlugin) {
    const macAddr = await this._getWlanMacAddress(wlanIntfPlugin);
    const phyName = await this._get80211PhyName();
    if (!phyName) {
      throw new Error("Failed to get 802.11 phy name");
    }
    if (!await wlanIntfPlugin.isInterfacePresent()) {
      await exec(`sudo iw phy ${phyName} interface add ${wlanIntfPlugin.name} type ${await this._getWlanInterfaceType(wlanIntfPlugin)}`);
    }
    await exec(`sudo ip link set ${wlanIntfPlugin.name} down`).catch((err) => {});
    await exec(`sudo ip link set ${wlanIntfPlugin.name} address ${macAddr}`).catch((err) => {});
  }

  async removeWLANInterface(wlanIntfPlugin) {
    await exec(`sudo iw dev ${wlanIntfPlugin.name} del`).catch((err) => {});
  }

  async _getWlanInterfaceType(wlanIntfPlugin) {
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

  async _getWlanMacAddress(wlanIntfPlugin) {
    if (wlanIntfPlugin.networkConfig.hwAddr)
      return wlanIntfPlugin.networkConfig.hwAddr;
    const cachedMac = await rclient.hgetAsync("intfMacs", wlanIntfPlugin.name);
    if (cachedMac)
      return cachedMac;
    const existingMacs = await rclient.hvalsAsync("intfMacs");
    
    // Generate a random MAC address with a default prefix
    // Using a common vendor prefix for locally administered addresses
    const defaultPrefix = "20:6D:31"; // Locally administered, unicast
    let newMac;
    let attempts = 0;
    const maxAttempts = 100;

    do {
      newMac = util.generateRandomMacAddress(defaultPrefix);
      attempts++;
    } while (existingMacs.includes(newMac) && attempts < maxAttempts);

    if (attempts >= maxAttempts) {
      log.error("Failed to generate unique MAC address after maximum attempts");
      // Fallback to a deterministic approach using interface name
      const hash = require('crypto').createHash('md5').update(wlanIntfPlugin.name).digest('hex');
      newMac = `${defaultPrefix}:${hash.substring(0, 2)}:${hash.substring(2, 4)}:${hash.substring(4, 6)}`;
    }

    // Save the generated MAC address to Redis
    await rclient.hsetAsync("intfMacs", wlanIntfPlugin.name, newMac);
    log.info(`Generated new MAC address for ${wlanIntfPlugin.name}: ${newMac}`);
    
    return newMac;
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
}

module.exports = OrangePlatform;
