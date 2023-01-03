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

'use strict';

const log = require('../util/logger.js')(__filename);

const exec = require('child-process-promise').exec;

const WIFI_DRV_NAME = '8821cu';

class WifiSD {
  constructor(platform) {
    this.platform = platform
  }

  async existsUsbWifi() {
    return exec('sudo lsusb -v -d 0bda: | fgrep -q 802.11ac').then(() => true).catch(() => false);
  }

  getDriverName() {
    return WIFI_DRV_NAME
  }

  async installDriver() {
    const kernelVersion = await exec('uname -r').then(result => result.stdout.trim()).catch((err) => {
      log.error(`Failed to get kernel version`, err.message);
      return null
    });
    if ( kernelVersion === null ) return;
    const koUpdated = await this.platform.overrideKernelModule(
      WIFI_DRV_NAME,
      this.platform.getBinaryPath() + '/' + kernelVersion,
      `/lib/modules/${kernelVersion}/kernel/drivers/net/wireless`
    )

    log.info(`kernel module updated is ${koUpdated}`);
    // load driver if exists Realtek USB WiFi dongle
    if (await this.existsUsbWifi() && !await this.platform.kernelModuleLoaded(WIFI_DRV_NAME)) {
      log.info('USB WiFi detected, loading kernel module');
      await exec(`sudo modprobe ${WIFI_DRV_NAME}`).catch((err) => {
        log.error(`failed to load ${WIFI_DRV_NAME}`, err.message);
      });
    }
  }

  async reloadDriver() {
    const kernelVersion = await exec('uname -r').then(result => result.stdout.trim()).catch((err) => {
      log.error(`Failed to get kernel version`, err.message);
      return null
    });
    const koReloaded = await this.platform.reloadKernelModule(
      WIFI_DRV_NAME,
      this.platform.getBinaryPath() + '/' + kernelVersion
    );
    log.info(`kernel module ${WIFI_DRV_NAME} reloaded is ${koReloaded}`);
  }

  getHostapdConfig() {
    return {
      max_num_sta: 5
    }
  }
}

module.exports = WifiSD
