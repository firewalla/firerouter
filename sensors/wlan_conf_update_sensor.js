/*    Copyright 2021 Firewalla Inc
 *
 *    This program is free software: you can redistribute it and/or modify
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

const Sensor = require('./sensor.js');
const fs = require('fs');
const ncm = require('../core/network_config_mgr.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const r = require('../util/firerouter.js');

class WlanConfUpdateSensor extends Sensor {
  async run() {
    const iface = platform.getWifiClientInterface();
    if (!iface)
      return;
    const filename = `/sys/class/net/${iface}`;
    fs.watchFile(filename, {interval: 2000}, (curr, prev) => {
      if (curr.ctimeMs > prev.ctimeMs) {
        this.log.info(`${iface} appears, check and update network config if necessary ...`);
        this.checkAndUpdateNetworkConfig(iface).catch((err) => {
          this.log.error(`Failed to check and update network config for ${iface}`, err.message);
        });
      }
    });
    // check initial state in 45 seconds
    setTimeout(async () => {
      const ifExists = await fs.promises.access(r.getInterfaceSysFSDirectory(iface), fs.constants.F_OK).then(() => true).catch((err) => false);
      if (ifExists) {
        this.log.info(`${iface} appears, check and update network config if necessary ...`);
        await this.checkAndUpdateNetworkConfig(iface).catch((err) => {
          this.log.error(`Failed to check and update network config for ${iface}`, err.message);
        });
      }
    }, 45000);
  }

  async checkAndUpdateNetworkConfig(iface) {
    if (!await r.verifyPermanentMAC(iface)) {
      this.log.error(`Permanent MAC address of ${iface} is not valid, ignore it`);
      return;
    }
    await ncm.acquireConfigRWLock(async () => {
      const currentConfig = await ncm.getActiveConfig();
      if (currentConfig && currentConfig.interface) { // assume "interface" exists under root
        if (!currentConfig.interface.wlan || !currentConfig.interface.wlan[iface]) {
          if (!currentConfig.interface.wlan)
            currentConfig.interface.wlan = {};
          const wlanConfig = {};
          wlanConfig[iface] = {
            enabled: true,
            wpaSupplicant: {},
            allowHotplug: true
          };
          currentConfig.interface.wlan = Object.assign({}, currentConfig.interface.wlan, wlanConfig);
          const errors = await ncm.tryApplyConfig(currentConfig).catch((err) => {
            this.log.error(`Failed to apply updated config`, err.message);
            return;
          });
          if (errors && errors.length != 0) {
            this.log.error(`Error occured while applying updated config`, errors);
            return;
          }
          await ncm.saveConfig(currentConfig, false);
        }
      }
    });
  }
}

module.exports = WlanConfUpdateSensor;