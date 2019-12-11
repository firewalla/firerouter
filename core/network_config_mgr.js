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

let instance = null;
const log = require('../util/logger.js')(__filename);
const rclient = require('../util/redis_manager').getPrimaryDBRedisClient();
const ns = require('./network_setup.js');
const exec = require('child-process-promise').exec;

class NetworkConfigManager {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async getPhyInterfaceNames() {
    const intfs = await exec("ls -l /sys/class/net/ | tail -n +2 | grep -v virtual | awk '{print $9}'").then((result) => result.stdout.split("\n").filter(line => line.length > 0));
    return intfs;
  }

  async getWANs() {
    const configs = ns.getWANs();
    return configs;
  }

  async getLANs() {
    const configs = ns.getLANs();
    return configs;
  }

  async getActiveConfig() {
    const configString = await rclient.getAsync("sysdb:networkConfig");
    if(configString) {
      try {
        const config = JSON.parse(configString);
        return config;
      } catch(err) {
        return null;
      }
    } else {
      return null;
    }
  }

  async getDefaultConfig() {
    const config = require('../network/default_setup.json');
    return config;
  }

  async validateConfig(config) {
    return [];
  }

  async tryApplyConfig(config, dryRun = false) {
    const currentConfig = (await this.getActiveConfig()) || (await this.getDefaultConfig());

    const errors = await ns.setup(config, dryRun);
    if (errors && errors.length != 0) {
      log.error("Failed to apply network config, rollback to previous setup", errors);
      await ns.setup(currentConfig).catch((err) => {
        log.error("Failed to rollback network config", err);
      });
    }
    return errors;
  }

  async saveConfig(networkConfig) {
    const configString = JSON.stringify(networkConfig);
    if (configString) {
      await rclient.setAsync("sysdb:networkConfig", configString);
    }
  }
}

module.exports = new NetworkConfigManager();