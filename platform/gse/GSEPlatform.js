/*    Copyright 2022-2023 Firewalla Inc.
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
const { exec, execFile } = require('child-process-promise');
const log = require('../../util/logger.js')(__filename);
const r = require('../../util/firerouter.js');
const util = require('../../util/util.js');
const sensorLoader = require('../../sensors/sensor_loader.js');
const WifiSD = require('../WifiSD.js')
const fs = require('fs');
const fsp = fs.promises;

const macCache = {};
const IF_WLAN0 = "wlan0";
const IF_WLAN1 = "wlan1";
let errCounter = 0;
const maxErrCounter = 100; // do not try to set mac address again if too many errors.
const R8125 = "r8125";
// touch this file in the user config folder to keep the r8125 driver shipped in the OS image
const R8125_OVERRIDE_DISABLE_FLAG = "disable_r8125_override";

class GSEPlatform extends Platform {
  getName() {
    return "gse";
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/files/default_setup.json`;
  }

  getWifiClientInterface() {
    return IF_WLAN0;
  }

  getWifiAPInterface() {
    return IF_WLAN1;
  }

  getMiniupnpdNftPath() {
    return `${this.getBinaryPath()}/u22/miniupnpd.nft`;
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
    return `wpa_cli`;
  }

  async getWpaPassphraseBinPath() {
    return `wpa_passphrase`;
  }

  async ledNormalVisibleStart() {
    await execFile("curl", ["-s", `${firestatusBaseURL}/fire?name=firerouter&type=normal_visible`]).catch( (err) => {
      log.error("Failed to set LED as WAN normal visible");
    });
  }

  async ledNormalVisibleStop() {
    await execFile("curl", ["-s", `${firestatusBaseURL}/resolve?name=firerouter&type=normal_visible`]).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAllNetworkDown() {
    await execFile("curl", ["-s", `${firestatusBaseURL}/fire?name=firerouter&type=network_down`]).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAnyNetworkUp() {
    await execFile("curl", ["-s", `${firestatusBaseURL}/resolve?name=firerouter&type=network_down`]).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  _isWLANInterface(iface) {
    return ["wlan0", "wlan1"].includes(iface);
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

  async setHardwareAddress(iface, hwAddr) {
    if (!this._isWLANInterface(iface)) {
      await super.setHardwareAddress(iface, hwAddr);
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
    await execFile("sudo", ["ip", "link", "set", iface, "down"]).catch((err) => {
      log.error(`Failed to turn off interface ${iface}`, err.message);
    });

    // set mac address
    await execFile("sudo", ["ip", "link", "set", iface, "address", hwAddr]).catch((err) => {
      log.error(`Failed to set MAC address of ${iface}`, err.message);
      errCounter++;
    });

    // start ifplug monitoring
    if(ifplug) {
      await ifplug.startMonitoringInterface(iface);
    }
  }

  // Replace the r8125 driver from the OS image with the one shipped in firerouter (TX fixes
  // from fw-gse-bsp#18 and #20). Rootfs is reset on every boot, so this reloads once per boot,
  // before any interface is configured.
  async overrideEthernetKernelModule() {
    const flagPath = `${r.getUserConfigFolder()}/${R8125_OVERRIDE_DISABLE_FLAG}`;
    if (await fsp.access(flagPath, fs.constants.F_OK).then(() => true).catch(() => false)) {
      log.info(`Skip overriding ${R8125}, ${flagPath} exists`);
      return;
    }
    const koPath = await this.getKoPath(R8125);
    if (!await fsp.access(koPath, fs.constants.F_OK).then(() => true).catch(() => false))
      return;

    // insmod does not reliably reject a module built for another kernel (a 5.10.110 r8125 loads
    // on 5.10.160 with modversions, then oopses on first xmit), so require the same vermagic
    // as the r8125 that came with the running kernel
    const sysKoPath = await execFile("modinfo", ["-n", R8125]).then((result) => result.stdout.trim()).catch(() => "");
    const koVermagic = await this.getModuleInfoField(koPath, "vermagic");
    const sysVermagic = sysKoPath ? await this.getModuleInfoField(sysKoPath, "vermagic") : "";
    if (!koVermagic || koVermagic !== sysVermagic) {
      log.error(`Skip overriding ${R8125}, vermagic "${koVermagic}" of ${koPath} does not match "${sysVermagic}" of ${sysKoPath || "system module"}`);
      return;
    }

    const koSrcVersion = await this.getModuleSrcVersion(koPath);
    const loadedSrcVersion = await this.getLoadedModuleSrcVersion(R8125);
    if (koSrcVersion && koSrcVersion === loadedSrcVersion)
      return;

    log.info(`Overriding ${R8125} with ${koPath}, srcversion ${loadedSrcVersion || "<not loaded>"} -> ${koSrcVersion}`);
    if (await this.isKernelModuleLoaded(R8125) && !await this.rmmodKernelModule(R8125))
      return;
    const loaded = await execFile("sudo", ["insmod", koPath]).then(() => true).catch((err) => {
      log.error(`Failed to insmod ${koPath}`, err.message);
      return false;
    });
    if (!loaded) {
      // never leave the box without an ethernet driver
      log.warn(`Falling back to ${R8125} from OS image`);
      await this.modprobeKernelModule(R8125);
      return;
    }
    log.info(`${R8125} overridden, srcversion ${await this.getLoadedModuleSrcVersion(R8125)}`);
  }

  async overrideWLANKernelModule() {
    // nothing to do, driver in os image now
  }

  async setMTU(iface, mtu) {
    if (iface === "eth1" || iface === "eth2") {
      const ifplug = sensorLoader.getSensor("IfPlugSensor");
      if (ifplug) {
        await ifplug.stopMonitoringInterface(iface);
      }
      await execFile("sudo", ["ip", "link", "set", iface, "down"]);
      await super.setMTU(iface, mtu);
      await execFile("sudo", ["ip", "link", "set", iface, "up"]);
      if (ifplug) {
        await ifplug.startMonitoringInterface(iface);
      }
    } else {
      await super.setMTU(iface, mtu);
    }
  }

  async getKoPath(module_name) {
    let koPath = await super.getKoPath(module_name);

    const compiler = await execFile("grep", ["-o", "aarch64.*-linux-gnu-gcc", "/proc/version"]).then(result => result.stdout.trim());
    if (compiler === "aarch64-none-linux-gnu-gcc") {
      const altKoPath = `${koPath}.aarch64-none-linux-gnu-gcc`;
      const altFileExists = await fsp.access(altKoPath, fs.constants.F_OK).then(() => true).catch(() => false);
      if (altFileExists) {
        koPath = altKoPath;
      }
    }
    return koPath;
  }

}

module.exports = GSEPlatform;
