/*    Copyright 2019 - 2025 Firewalla Inc
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

const Sensor = require("./sensor.js");
const PlatformLoader = require('../platform/PlatformLoader.js');
const platform = PlatformLoader.getPlatform();
const rclient = require('../util/redis_manager.js').getRedisClient();
const constants = require('../util/constants.js');

class PDOSensor extends Sensor {

  async run() {
    if (!platform.isPDOSupported()) {
      this.log.info("PDO is not supported on this platform");
      return;
    }

    const pdoInfo = await this.getPDOInfo();
    this.log.info("PDO info: ", pdoInfo);
  }

  async getPDOInfo() {
    if (!this.pdoInfo) {
      this.pdoInfo = await platform.loadPDOInfo();
    }
    return this.pdoInfo;
  }

  async setPowerMode(powerMode) {
    await rclient.setAsync(constants.REDIS_KEY_POWER_MODE, powerMode);
  }

  async getPowerMode() {
    const powerMode = await rclient.getAsync(constants.REDIS_KEY_POWER_MODE) || constants.POWER_MODE_ONDEMAND;
    return powerMode;
  }

  async getEffectivePowerMode() {
    if (this.pdoInfo) {
      const powerMode = await this.getPowerMode();
      return platform.getEffectivePowerMode(this.pdoInfo, powerMode);
    } else {
      return constants.POWER_MODE_POWERSAVE;
    }
  }

  async enforcePowerMode() {
    // set Wi-Fi firmware bdf according to power mode and pdo info    
  }
}

module.exports = PDOSensor;
