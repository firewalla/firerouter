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
const { execSync } = require('child_process');
const exec = require('child-process-promise').exec;
const fs = require('fs'); 
const log = require('../../util/logger.js')(__filename);
const util = require('../../util/util.js');
const sensorLoader = require('../../sensors/sensor_loader.js');
const WIFI_DRV_NAME='8821cu';

const WLANIF_CLIENT = "wlan0";
const WLANIF_AP = "wlan1";
let errCounter = 0;
const maxErrCounter = 100; // do not try to set mac address again if too many errors.

class GoldPlatform extends Platform {
  getName() {
    return "gold";
  }

  getLSBCodeName() {
    return execSync("lsb_release -cs", {encoding: 'utf8'}).trim();
  }

  isUbuntu20() {
    return this.getLSBCodeName() === 'focal';
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/files/default_setup.json`;
  }

  async getWlanVendor() {
    return WIFI_DRV_NAME;
  }

  getWpaCliBinPath() {
    if (this.isUbuntu20())
      return `${__dirname}/bin/u20/wpa_cli`
    else
      return `${__dirname}/bin/wpa_cli`;
  }

  getWpaPassphraseBinPath() {
    return `${__dirname}/bin/wpa_passphrase`;
  }

  getModelName() {
    return "Firewalla Gold";
  }

  async getActiveMac(iface) {
    return await fs.readFileAsync(`/sys/class/net/${iface}/address`, {encoding: 'utf8'}).then(result => result.trim().toUpperCase()).catch(() => "");
  }

  async setHardwareAddress(iface, hwAddr) {
    log.info(`set ${iface} hardware address to ${hwAddr}`);
    if(iface !== WLANIF_AP) {
      // for all ifaces but wlan1, use function from base class
      await super.setHardwareAddress(iface, hwAddr);
      return;
    }

    /* ONLY set hardware address for wlan1 in Gold */

    if(errCounter >= maxErrCounter) { // should not happen in production, just a self protection
      log.error("Skip set hardware address if too many errors on setting hardware address.");
      return;
    }

    if(hwAddr) {
      const activeMac = await this.getActiveMac(iface);
      if(activeMac === hwAddr) {
        log.info(`Skip setting hwaddr of ${iface}, as it's already been configured.`);
        return;
      }
      await this._setHardwareAddressWlan1(iface,hwAddr);
    }
  }

  async resetHardwareAddress(iface) {
    log.info(`reset ${iface} hardware address`);
    if(iface !== WLANIF_AP) {
      // for all ifaces but wlan1, use function from base class
      await super.resetHardwareAddress(iface);
      return;
    }

    const activeClientMac = await this.getActiveMac(WLANIF_CLIENT);
    if(!activeClientMac) {
      log.error("Unable to get mac for iface", WLANIF_CLIENT);
      return;
    }

    const activeAPMac = await this.getActiveMac(WLANIF_AP);
    const expectAPMac =  Number(parseInt(activeClientMac.replace(/:/g,''),16)+1).toString(16).replace(/(..)(?=.)/g,'$1:');

    if ( activeAPMac !== expectAPMac ) {
      if(errCounter >= maxErrCounter) { // should not happen in production, just a self protection
        log.error(`Skip set hwaddr of ${WLANIF_AP} if too many errors on setting hardware address.`);
        return;
      }

      log.info(`Resetting the hwaddr of ${WLANIF_AP} to :`, expectAPMac);
      await this._setHardwareAddressWlan1(expectAPMac);
    } else {
      log.info(`no need to reset hwaddr of ${WLANIF_AP}, it's already resetted.`);
    }
  }

  async _setHardwareAddressWlan1(hwAddr) {
    log.info(`set hardware address of wlan1 to ${hwAddr}`);
    // stop ifplug monitoring
    const ifplug = sensorLoader.getSensor("IfPlugSensor");
    if(ifplug) {
      await ifplug.stopMonitoringInterface(WLANIF_AP);
      await ifplug.stopMonitoringInterface(WLANIF_CLIENT);
    }

    // shutdown dependant services
    await exec(`sudo systemctl stop firerouter_wpa_supplicant@${WLANIF_CLIENT}`).catch((err) => {})
    await exec(`sudo systemctl stop firerouter_hostapd@${WLANIF_AP}`).catch((err) => {})

    // a hard code 1-second wait for system to release wifi interfaces
    await util.delay(1000);

    // force shutdown interfaces
    await exec(`sudo ip link set ${WLANIF_CLIENT} down`).catch((err) => {
      log.error(`Failed to turn off interface ${WLANIF_CLIENT}`, err.message);
    });
    await exec(`sudo ip link set ${WLANIF_AP} down`).catch((err) => {
      log.error(`Failed to turn off interface ${WLANIF_AP}`, err.message);
    });

    // set mac address
    log.info(`Set ${WLANIF_AP} MAC to ${hwAddr}`);
    await exec(`sudo ip link set ${WLANIF_AP} address ${hwAddr}`).catch((err) => {
      log.error(`Failed to set MAC address of ${WLANIF_AP}`, err.message);
      errCounter++;
    });

    // start ifplug monitoring
    if(ifplug) {
      await ifplug.startMonitoringInterface(WLANIF_CLIENT);
      await ifplug.startMonitoringInterface(WLANIF_AP);
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
}

module.exports = GoldPlatform;