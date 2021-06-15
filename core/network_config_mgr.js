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
const rclient = require('../util/redis_manager').getRedisClient();
const ns = require('./network_setup.js');
const exec = require('child-process-promise').exec;
const {Address4, Address6} = require('ip-address');
const _ = require('lodash');
const pl = require('../platform/PlatformLoader.js');
const platform = pl.getPlatform();

class NetworkConfigManager {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async getPhyInterfaceNames() {
    const intfs = await exec("ls -l /sys/class/net | awk '/^l/ && !/virtual/ {print $9}'").then((result) => result.stdout.split("\n").filter(line => line.length > 0));
    return intfs;
  }

  async getWANs() {
    const configs = await ns.getWANs();
    return configs;
  }

  async getLANs() {
    const configs = await ns.getLANs();
    return configs;
  }

  async getInterfaces() {
    const configs = await ns.getInterfaces();
    return configs;
  }

  async getInterface(intf) {
    return ns.getInterface(intf);
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
    const defaultConfigJson = platform.getDefaultNetworkJsonFile();
    const config = require(defaultConfigJson);
    return config;
  }

  async validateConfig(config) {
    if (!config)
      return ["config is not defined"];
    if (!config.interface)
      return ["interface is not defined"];
    const ifaceIp4PrefixMap = {};
    for (const ifaceType in config.interface) {
      const ifaces = config.interface[ifaceType];
      for (const name in ifaces) {
        const iface = ifaces[name];
        if (iface.ipv4 && _.isString(iface.ipv4) || iface.ipv4s && _.isArray(iface.ipv4s)) {
          let ipv4s = [];
          if (iface.ipv4 && _.isString(iface.ipv4))
            ipv4s.push(iface.ipv4);
          if (iface.ipv4s && _.isArray(iface.ipv4s))
            Array.prototype.push.apply(ipv4s, iface.ipv4s);
          ipv4s = ipv4s.filter((v, i, a) => a.indexOf(v) === i);
          for (const ipv4 of ipv4s) {
            const addr = new Address4(ipv4);
            if (!addr.isValid())
              return [`ipv4 of ${name} is not valid ${ipv4}`];
            // check ipv4 subnet conflict
            for (const prefix in ifaceIp4PrefixMap) {
              const i = ifaceIp4PrefixMap[prefix];
              const addr2 = new Address4(prefix);
              if ((addr.isInSubnet(addr2) || addr2.isInSubnet(addr)) && name !== i)
                return [`ipv4 of ${name} conflicts with ipv4 of ${i}`];
            }
            ifaceIp4PrefixMap[ipv4] = name;
          }
        }
      }
    }
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