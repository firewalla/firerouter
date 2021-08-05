/*    Copyright 2019-2021 Firewalla Inc.
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
const { exec, spawn } = require('child-process-promise')
const readline = require('readline');
const {Address4, Address6} = require('ip-address');
const _ = require('lodash');
const pl = require('../platform/PlatformLoader.js');
const platform = pl.getPlatform();
const r = require('../util/firerouter.js');
const AsyncLock = require('async-lock');
const lock = new AsyncLock();
const LOCK_SWITCH_WIFI = "LOCK_SWITCH_WIFI";

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

  async switchWifi(intf, ssid) {
    return new Promise((resolve, reject) => {
      lock.acquire(LOCK_SWITCH_WIFI, async (done) => {
        const iface = await ns.getInterface(intf);
        if (!iface) {
          done(null, [`Interface ${intf} is not found`]);
          return;
        }
        const config = iface.config;
        if (config.enabled !== true) {
          done(null, [`Interface ${intf} is not enabled`]);
          return;
        }
        if (config.meta.type !== "wan") {
          done(null, [`Interface ${intf} is not a WAN interface`]);
          return;
        }
        if (!config.wpaSupplicant) {
          done(null, [`wpa_supplicant is not configured on ${intf}`]);
          return;
        } 
        const wpaCliPath = platform.getWpaCliBinPath();
        const socketDir = `${r.getRuntimeFolder()}/wpa_supplicant/${intf}`;
        const networks = await exec(`sudo ${wpaCliPath} -p ${socketDir} list_networks | tail +3`).then(result => result.stdout.trim().split('\n').map(line => {
          const [id, ssid, bssid, flags] = line.split('\t', 4);
          return {id, ssid, bssid, flags};
        })).catch(err => []);
        const currentNetwork = networks.find(n => n.flags && n.flags.includes("CURRENT"));
        const selectedNetwork = networks.find(n => n.ssid === ssid);
        if (!selectedNetwork) {
          done(null, [`ssid ${ssid} is not configured in ${intf} settings`]);
          return;
        }
        let error = await exec(`sudo ${wpaCliPath} -p ${socketDir} select_network ${selectedNetwork.id}`).then(() => null).catch((err) => err.message);
        if (error) {
          done(null, [error]);
          return;
        }
        const t1 = Date.now() / 1000;
        const checkTask = setInterval(async () => {
          const state = await exec(`sudo ${wpaCliPath} -p ${socketDir} status | grep wpa_state`).then(result => result.stdout.trim().endsWith("=COMPLETED")).catch((err) => false);
          if (state === true) {
            clearInterval(checkTask);
            for (const network of networks) {
              // select_network will disable all other ssids, re-enable other ssid
              if (network.id !== selectedNetwork.id && (!network.flags || !network.flags.includes("DISABLED")))
                await exec(`sudo ${wpaCliPath} -p ${socketDir} enable_network ${network.id}`).catch((err) => { });
            }
            done(null, []);
          } else {
            const t2 = Date.now() / 1000;
            if (t2 - t1 > 15) {
              clearInterval(checkTask);
              if (currentNetwork) // switch back to previous ssid
                await exec(`sudo ${wpaCliPath} -p ${socketDir} select_network ${currentNetwork.id}`).catch((err) => { });
              else // deselect ssid
                await exec(`sudo ${wpaCliPath} -p ${socketDir} disable_network ${selectedNetwork.id}`).catch((err) => { });
              for (const network of networks) {
                // select_network will disable all other ssids, re-enable other ssid
                if ((!currentNetwork || network.id !== currentNetwork.id) && (!network.flags || !network.flags.includes("DISABLED")))
                  await exec(`sudo ${wpaCliPath} -p ${socketDir} enable_network ${network.id}`).catch((err) => { });
              }
              done(null, [`Failed to switch to ${ssid}`]);
            }
          }
        }, 3000);
      }, (err, ret) => {
        if (err)
          reject(err);
        else
          resolve(ret);
      });
    });
  }

  async getWlanAvailable(intf) {
    const promise = spawn('sudo', ['timeout', '20s', 'iw', 'dev', intf, 'scan'])
    const cp = promise.childProcess
    const rl = readline.createInterface({input: cp.stdout});

    const results = []
    let wlan, ie

    for await (const line of rl) {
      try {
        if (line.startsWith('BSS ')) {
          wlan && results.push(wlan)

          const mac = line.substring(4, 21).toUpperCase()
          wlan = { mac }
        }

        const ln = line.trimStart() // don't trim end in case SSID has trailing spaces

        if (ln.startsWith('signal:')) {
          // https://git.kernel.org/pub/scm/linux/kernel/git/jberg/iw.git/tree/nl80211.h
          // * @NL80211_BSS_SIGNAL_MBM: signal strength of probe response/beacon
          // *  in mBm (100 * dBm) (s32)
          // * @NL80211_BSS_SIGNAL_UNSPEC: signal strength of the probe response/beacon
          // *  in unspecified units, scaled to 0..100 (u8)
          //
          // if unspecified unit, it's be positive number, while it's negative in dBm
          wlan.signal = Number(ln.substring(8).split(' ')[0])
        }
        else if (ln.startsWith('freq:')) {
          wlan.freq = Number(ln.substring(6))
        }
        else if (ln.startsWith('SSID:')) {
          wlan.ssid = ln.substring(6)
        }
        // else if (ln.startsWith('HT Operation:')) {
        //   ie = { }
        // }
        else if (ln.startsWith('* primary channel:')) {
          wlan.channel = Number(ln.substring(19))
        }
        else if (ln.startsWith('RSN:')) {
          const index = ln.indexOf('Version:')
          ie = { ver: Number(ln.substring(index + 8)) }
          wlan.rsn = ie
        }
        else if (ln.startsWith('WPA:')) {
          const index = ln.indexOf('Version:')
          ie = { ver: Number(ln.substring(index + 8)) }
          wlan.wpa = ie
        }
        else if (ln.startsWith('* Group cipher:')) {
          ie.group = ln.substring(16)
        }
        else if (ln.startsWith('* Pairwise ciphers:')) {
          ie.pairwises = ln.substring(20).trim().split(' ')
        }
        else if (ln.startsWith('* Authentication suites:')) {
          ie.suites = ln.substring(25).trim().split(' ')
        }
      } catch(err) {
        log.error('Error parsing line', line, '\n', err)
      }
    }

    await promise

    results.push(wlan)

    return _.sortBy(results, 'channel')
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
      this._scheduleRedisBackgroundSave();
    }
  }

  _scheduleRedisBackgroundSave() {
    if (this.bgsaveTask)
      clearTimeout(this.bgsaveTask);
    this.bgsaveTask = setTimeout(() => {
      rclient.bgsaveAsync().catch((err) => {
        log.error("Redis background save returns error", err.message);
      });
    }, 3000);
  }
}

module.exports = new NetworkConfigManager();
