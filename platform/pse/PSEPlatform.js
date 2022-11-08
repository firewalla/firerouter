/*    Copyright 2022 Firewalla Inc.
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

const Platform = require('../Platform.js');

const firestatusBaseURL = "http://127.0.0.1:9966";
const exec = require('child-process-promise').exec;
const log = require('../../util/logger.js')(__filename);
const sensorLoader = require('../../sensors/sensor_loader.js');
const WifiSD = require('../WifiSD.js')

const macCache = {};

let errCounter = 0;
const maxErrCounter = 100; // do not try to set mac address again if too many errors.

class PSEPlatform extends Platform {
  getName() {
    return "pse";
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/files/default_setup.json`;
  }

  getWifiClientInterface() {
    return "wlan0";
  }

  wifiSD() {
    // only 1 wifi sd supported now
    if (!this._wifiSD) {
      this._wifiSD = new WifiSD(this)
    }
    return this._wifiSD
  }

  async getWlanVendor() {
    return this.wifiSD().getDriverName()
  }

  async getWpaCliBinPath() {
    return `${__dirname}/bin/wpa_cli`;
  }

  async getWpaPassphraseBinPath() {
    return `${__dirname}/bin/wpa_passphrase`;
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

  clearMacCache(iface) {
    if (macCache[iface])
      delete macCache[iface];
  }

  _isPhysicalInterface(iface) {
    return ["eth0", "eth1"].includes(iface);
  }

  _isWLANInterface(iface) {
    return ["wlan0", "wlan1"].includes(iface);
  }

  async getMacByIface(iface) {
    if(!this._isPhysicalInterface(iface) && !this._isWLANInterface(iface)) {
      return null;
    }

    if(macCache[iface]) {
      return macCache[iface];
    }

    const mac = await this._getMacByIface(iface);
    macCache[iface] = mac;
    return mac;
  }

  async _getPermanentMac(iface) {
    return await exec(`sudo ethtool -P ${iface} | awk '{print $3}'`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => {
      log.error(`Failed to get permanent address of ${iface}`, err.message);
      return null;
    });
  }

  async _calculatedMacWlan1() {
    const activeMacWlan0 = await this.getActiveMac("wlan0");
    const calculatedMacWlan1 =  Number(parseInt(activeMacWlan0.replace(/:/g,''),16)+1).toString(16).replace(/(..)(?=.)/g,'$1:');
    return calculatedMacWlan1;
  }

  async _getMacByIface(iface) {
    switch(iface) {
      case "eth0":
        return await this.getMac(0);
      case "eth1":
        return await this.getMac(1);
      case "wlan0":
        return await this._getPermanentMac(iface);
      case "wlan1":
        return await this._calculatedMacWlan1();
    }

    return;
  }

  // need to adapt to PSE board
  async getMac(index) {
    const mac = await exec(`seq 0 5 | xargs -I ZZZ -n 1 sudo i2cget -y 0 0x51 0x${index}ZZZ | cut -d 'x' -f 2 | paste -sd ':'`)
          .then(result => result.stdout.trim())
          .catch((err) => {
            log.error(`Failed to get MAC address for index ${index} from EPROM`, err.message);
            return "";
          });
    return mac.toUpperCase();
  }

  getModelName() {
    return "Firewalla Purple SE";
  }

  // must kill ifplugd before changing purple mac address
  async setHardwareAddress(iface, hwAddr) {
    if(!this._isPhysicalInterface(iface) && !this._isWLANInterface(iface)) {
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
    if(!this._isPhysicalInterface(iface) && !this._isWLANInterface(iface)) {
      // for non-phy ifaces, use function from base class
      await super.resetHardwareAddress(iface);
      return;
    }

    const activeMac = await this.getActiveMac(iface);
    const origMac = await this.getMacByIface(iface);
    if(!origMac) {
      log.error("Unable to get original mac for iface", iface);
      return;
    }

    if ((activeMac && activeMac.toUpperCase()) !== (origMac && origMac.toUpperCase())) {
      if(errCounter >= maxErrCounter) { // should not happen in production, just a self protection
        log.error(`Skip set hwaddr of ${iface} if too many errors on setting hardware address.`);
        return;
      }

      log.info(`Resetting the hwaddr of ${iface} back to factory default:`, origMac);
      await this._setHardwareAddress(iface, origMac);
    } else {
      log.info(`no need to reset hwaddr of ${iface}, it's already resetted.`);
    }
  }

  async overrideWLANKernelModule() {
    // nothing to do, driver in os image now
  }
}

module.exports = PSEPlatform;
