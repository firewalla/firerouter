/*    Copyright 2019 Firewalla Inc
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

const log = require('../util/logger.js')(__filename);
const config = require('../util/config.js').getConfig();

const _ = require('lodash');

const sensors = {};

async function initSensors() {
  if (_.isEmpty(config.sensors)) {
    return;
  }

  for (let sensor of config.sensors) {
    try {
      const filePath = sensor.file_path;
      const sensorConfig = sensor.config;
      const sensorClass = require(filePath);
      await sensorClass.prepare();
      const sensorInstance = new sensorClass(sensorConfig);
      sensors[sensorInstance.constructor.name] = sensorInstance;
      await sensorInstance.run();
    } catch (err) {
      log.error("Failed to initialize sensor ", sensor, err);
    }
  }
}

function getSensor(name) {
  return sensors[name];
}

module.exports = {
  initSensors: initSensors,
  getSensor: getSensor
}
