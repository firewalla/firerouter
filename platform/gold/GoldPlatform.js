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

const Platform = require('../Platform.js');
const exec = require('child-process-promise').exec;
const fs = require('fs'); 
const log = require('../../util/logger.js')(__filename);
const util = require('../../util/util.js');
const sensorLoader = require('../../sensors/sensor_loader.js');
const WIFI_DRV_NAME='8821cu';

const IF_WLAN0 = "wlan0";
const IF_WLAN1 = "wlan1";
let errCounter = 0;
const maxErrCounter = 100; // do not try to set mac address again if too many errors.
const macCache = {};

class GoldPlatform extends Platform {
  getName() {
    return "gold";
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
    return `${__dirname}/files/default_setup.json`;
  }

  async getWlanVendor() {
    return WIFI_DRV_NAME;
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

  getModelName() {
    return "Firewalla Gold";
  }

  _isWLANInterface(iface) {
    return ["wlan0", "wlan1"].includes(iface);
  }

  async getActiveMac(iface) {
    return await fs.readFileAsync(`/sys/class/net/${iface}/address`, {encoding: 'utf8'}).then(result => result.trim().toUpperCase()).catch(() => "");
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

      log.info(`Resetting the hwaddr of ${iface} to :`, expectMac);
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
    log.info(`Set ${iface} MAC to ${hwAddr}`);
    await exec(`sudo ip link set ${iface} address ${hwAddr}`).catch((err) => {
      log.error(`Failed to set MAC address of ${iface}`, err.message);
      errCounter++;
    });

    // start ifplug monitoring
    if(ifplug) {
      await ifplug.startMonitoringInterface(iface);
    }
  }

  async existsUsbWifi() {
    return await exec('lsusb -v -d 0bda: | fgrep -q Wireless').then(result => { return true;}).catch((err)=>{ return false; });
  }

  async overrideWLANKernelModule() {
    const kernelVersion = await exec('uname -r').then(result => result.stdout.trim()).catch((err) => {
      log.error(`Failed to get kernel version`, err.message);
      return null
    });
    if ( kernelVersion === null ) return;
    const koUpdated = await this.overrideKernelModule(
      WIFI_DRV_NAME,
      this.getBinaryPath()+'/'+kernelVersion,
      `/lib/modules/${kernelVersion}/kernel/drivers/net/wireless`);

    log.info(`kernel module updated is ${koUpdated}`);
    if (koUpdated) {
      // load driver if exists Realtek USB WiFi dongle
      if (this.existsUsbWifi()) {
        log.info('USB WiFi detected, loading kernel module');
        await exec(`sudo modprobe ${WIFI_DRV_NAME}`).catch((err)=>{
          log.error(`failed to load ${WIFI_DRV_NAME}`,err.message);
        });
      }
    }
  }

  async installWLANTools() {
    if (await this.isUbuntu22()) { // u22 has built-in wlan tools
      return;
    }

    await this._installWLANTools();
  }

  async _installWLANTools() {
    log.info("Installing WLAN tools for Gold");
    const codeName = await this.getLSBCodeName();
    let codeDir = '';
    switch (codeName) {
      case 'bionic' : codeDir = '';     break;
      case 'focal'  : codeDir = 'u20/'; break;
      default: log.error(`Un-supported Ubuntu release:`, codeName); return;
    }
    const iwtPathPrefix = this.getBinaryPath()+'/'+codeDir;
    log.info("  Installing iwconfig ...");
    await exec(`sudo install -v -m 755 ${iwtPathPrefix}/iwconfig /sbin/`).catch((err)=>{
      log.error(`failed to copy iwconfig:`,err.message)
    });
    log.info("  Installing libiw.so.30 ...");
    await exec(`sudo install -v -m 644 ${iwtPathPrefix}/libiw.so.30 /lib/x86_64-linux-gnu/`).catch((err)=>{
      log.error(`failed to copy libiw.so.30:`,err.message)
    });
  }
}

module.exports = GoldPlatform;
