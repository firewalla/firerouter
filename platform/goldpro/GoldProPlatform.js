/*    Copyright 2021-2023 Firewalla Inc.
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
const util = require('../../util/util.js');
const sensorLoader = require('../../sensors/sensor_loader.js');
const WifiSD = require('../WifiSD.js')

const IF_WLAN0 = "wlan0";
const IF_WLAN1 = "wlan1";
let errCounter = 0;
const maxErrCounter = 100; // do not try to set mac address again if too many errors.
const macCache = {};

class GoldProPlatform extends Platform {
  getName() {
    return "goldpro";
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/files/default_setup.json`;
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
    if (await this.isUbuntu20())
      return `${__dirname}/bin/u20/wpa_cli`
    else if (await this.isUbuntu22())
      return `wpa_cli` // use system native
    else
      return `${__dirname}/bin/wpa_cli`;
  }

  async getWpaPassphraseBinPath() {
    if (await this.isUbuntu22())
      return `wpa_passphrase` // use system native
    else
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

  getModelName() {
    return "Firewalla Gold Pro";
  }

  _isWLANInterface(iface) {
    return ["wlan0", "wlan1"].includes(iface);
  }

  async setHardwareAddress(iface, hwAddr) {
    log.info(`set ${iface} hardware address to ${hwAddr}`);
    if(!this._isWLANInterface(iface)) {
      // for non-WLAN interfaces, use function from base class
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
      await this._setHardwareAddress(iface,hwAddr);
    }
  }

  getWifiClientInterface() {
    return IF_WLAN0;
  }

  getWifiAPInterface() {
    return IF_WLAN1;
  }

  clearMacCache(iface) {
    if (macCache[iface])
      delete macCache[iface];
  }

  async getMacByIface(iface) {
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
    const activeMacWlan0 = await this.getActiveMac(IF_WLAN0);
    const calculatedMacWlan1 =  Number(parseInt(activeMacWlan0.replace(/:/g,''),16)+1).toString(16).replace(/(..)(?=.)/g,'$1:');
    return calculatedMacWlan1;
  }

  async _getMacByIface(iface) {
    switch(iface) {
      case "wlan0":
        return await this._getPermanentMac(iface);
      case "wlan1":
        return await this._calculatedMacWlan1();
    }
    return;
  }

  async resetHardwareAddress(iface) {
    log.info(`reset ${iface} hardware address`);
    if(!this._isWLANInterface(iface)) {
      // for non-WLAN interfaces, use function from base class
      await super.resetHardwareAddress(iface);
      return;
    }

    const activeMac = await this.getActiveMac(iface);
    const expectMac = await this.getMacByIface(iface);

    if ( (activeMac && activeMac.toUpperCase()) !== (expectMac && expectMac.toUpperCase()) ) {
      if(errCounter >= maxErrCounter) { // should not happen in production, just a self protection
        log.error(`Skip set hwaddr of ${iface} if too many errors on setting hardware address.`);
        return;
      }

      await this._setHardwareAddress(iface, expectMac);
    } else {
      log.info(`no need to reset hwaddr of ${iface}, it's already in place.`);
    }
  }

  async _setHardwareAddress(iface,hwAddr) {
    log.info(`set hardware address of ${iface} to ${hwAddr}`);

    // stop ifplug monitoring
    const ifplug = sensorLoader.getSensor("IfPlugSensor");
    if(ifplug) {
      await ifplug.stopMonitoringInterface(iface);
    }

    // a hard code 1-second wait for system to release wifi interfaces
    await util.delay(1000);

    // force shutdown interfaces
    await exec(`sudo ip link set ${iface} down`).catch((err) => {
      log.error(`Failed to turn off interface ${iface}`, err.message);
    });

    // set mac address
    await exec(`sudo ip link set ${iface} address ${hwAddr}`).catch((err) => {
      log.error(`Failed to set MAC address of ${iface}`, err.message);
      errCounter++;
    });

    // start ifplug monitoring
    if(ifplug) {
      await ifplug.startMonitoringInterface(iface);
    }
  }

  async overrideWLANKernelModule() {
    if (await this.isUbuntu22()) { // u22 has built-in wifi kernel modules
      return;
    }

    await this.wifiSD().installDriver()
  }
}

module.exports = GoldProPlatform;
