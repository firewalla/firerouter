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
const { exec } = require('child-process-promise');
const { spawn } = require('child_process')
const readline = require('readline');
const {Address4, Address6} = require('ip-address');
const _ = require('lodash');
const pl = require('../platform/PlatformLoader.js');
const platform = pl.getPlatform();
const r = require('../util/firerouter.js');
const AsyncLock = require('async-lock');
const lock = new AsyncLock();

const fsp = require('fs').promises;
const util = require('../util/util.js');

const LOCK_SWITCH_WIFI = "LOCK_SWITCH_WIFI";

const Promise = require('bluebird');

class NetworkConfigManager {
  constructor() {
    if(instance === null) {
      this.wanTestResult = {};
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

  async getInterfaceSimple(intf) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance('interface', intf);
    // ethX interfaces are always presented in config for now

    if(!plugin) {
      return {carrier : 0};
    }

    const result = (await plugin.readyToConnect().catch((err) => false)) ? 1 : 0;
    return { carrier : result };
  }

  isSwitchingWifi() {
    return lock.isBusy(LOCK_SWITCH_WIFI)
  }

  async switchWifi(intf, ssid, params = {}, testOnly = false) {
    return new Promise((resolve, reject) => {
      lock.acquire(LOCK_SWITCH_WIFI, async (done) => {
        try {
          const iface = await ns.getInterface(intf);
          const ssidHex = util.getHexStrArray(ssid).map(hex => `\\x${hex}`).join("");
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
          const wpaCliPath = await platform.getWpaCliBinPath();
          const socketDir = `${r.getRuntimeFolder()}/wpa_supplicant/${intf}`;
          const networks = await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} list_networks | tail -n +2`).then(result => result.stdout.trim().split('\n').map(line => {
            // TODO: taking care of SSID with '\t'?
            const [id, ssid, bssid, flags] = line.split('\t', 4);
            const hexArray = [];
            for (let i = 0; i < ssid.length; i++) {
              if (ssid.substring(i).startsWith("\\x")) {
                hexArray.push(ssid.substr(i + 2, 2));
                i += 3;
              } else {
                hexArray.push(util.getHexStrArray(ssid.substr(i, 1))[0]);
              }
            }
            const ssidHex = hexArray.map(hex => `\\x${hex}`).join("");
            return {id, ssid, ssidHex, bssid, flags};
          })).catch(err => {
            log.error('Failed to parse network list', err)
            return []
          });
          const currentNetwork = networks.find(n => n.flags && n.flags.includes("CURRENT"));
          // refresh interface link state to relinquish resources due to potential driver bug
          await exec(`sudo ip link set ${intf} down`).catch((err) => {});
          await exec(`sudo ip link set ${intf} up`).catch((err) => {});
          let selectedNetwork = networks.find(n => n.ssid === ssid || n.ssidHex === ssidHex); // in case of non-ascii characters, need to compare with hex string
          if (!selectedNetwork) {
            log.info(`ssid ${ssid} is not configured in ${intf} settings yet, will try to add a new network ...`);
            const networkId = await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} add_network`).then((result) => result.stdout.trim()).catch((err) => null);
            if (networkId === null) {
              done(null, [`Failed to add new network ${ssid}`]);
              return;
            }
            selectedNetwork = {id: networkId, ssid: ssid, bssid: params.bssid, flags: null};
          }
          if (!params.hasOwnProperty("ssid"))
            params.ssid = ssid;
          for (const key of Object.keys(params)) {
            const value = await util.generateWpaSupplicantConfig(key, params);
            const error = await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} set_network ${selectedNetwork.id} ${key} ${value}`).then(() => null).catch((err) => err.message);
            if (error) {
              done(null, [error]);
              return;
            }
          }
          let error = await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} select_network ${selectedNetwork.id}`).then(() => null).catch((err) => err.message);
          if (error) {
            done(null, [error]);
            return;
          }
          const t1 = Date.now() / 1000;
          let t2 = null;
          const checkTask = setInterval(async () => {
            const state = await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} status | grep wpa_state`).then(result => result.stdout.trim().endsWith("=COMPLETED")).catch((err) => false);
            if (state === true) {
              if (!testOnly) {
                clearInterval(checkTask);
                for (const network of networks) {
                  // select_network will disable all other ssids, re-enable other ssid
                  if (network.id !== selectedNetwork.id && (!network.flags || !network.flags.includes("DISABLED")))
                    await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} enable_network ${network.id}`).catch((err) => { });
                }
                done(null, []);
                return;
              }
            } else {
              t2 = Date.now() / 1000;
            }
            // if timeout exceeded or test only is set and connection is successful, switch back to previous setup
            if (t2 - t1 > 15 || state === true && testOnly) {
              clearInterval(checkTask);
              // refresh interface link state to relinquish resources due to potential driver bug
              await exec(`sudo ip link set ${intf} down`).catch((err) => {});
              await exec(`sudo ip link set ${intf} up`).catch((err) => {});
              // restore config from configuration file
              await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} reconfigure`).catch((err) => { });
              if (currentNetwork) // switch back to previous ssid
                await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} select_network ${currentNetwork.id}`).catch((err) => { });
              else // deselect ssid
                await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} disable_network ${selectedNetwork.id}`).catch((err) => { });
              for (const network of networks) {
                // select_network will disable all other ssids, re-enable other ssid
                if ((!currentNetwork || network.id !== currentNetwork.id) && (!network.flags || !network.flags.includes("DISABLED")))
                  await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} enable_network ${network.id}`).catch((err) => { });
              }
              if (state === true)
                done(null, []);
              else
                done(null, [`Failed to switch to ${ssid}`]);
            }
          }, 3000);
        } catch(err) {
          done(null, [err])
        }
      }, (err, ret) => {
        if (err)
          reject(err);
        else
          resolve(ret);
      });
    });
  }

  async checkWanConnectivity(iface, options = {pingTestCount: 1}) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const intfPlugin = pluginLoader.getPluginInstance("interface", iface);
    if (!intfPlugin)
      throw new Error(`Interface ${iface} is not found in network config`);
    if (!intfPlugin.isWAN())
      throw new Error(`Interface ${iface} is not a WAN interface`);

    let result = {};

    result = await intfPlugin.checkWanConnectivity(["1.1.1.1", "8.8.8.8", "9.9.9.9"], 1, 0.5, "github.com", options);
    if (result.dns === null) {
      result.dns = false;
    }

    // if carrier not ready, just skip http testings
    if(result.carrier) {
      const sites = options.httpSites || ["http://captive.apple.com", "http://cp.cloudflare.com", "http://clients3.google.com/generate_204"];

      // return if any of them succeeds
      const httpResult = await Promise.any(sites.map(async (site) => {
        const result = await intfPlugin.checkHttpStatus(site);
        if(!result) {
          throw new Error("http check failed on site " + site);
        }
        return result;
      })).catch((err) => {
        log.error("Failed to check http status on all sites, err:", err.message);
      });

      if (httpResult) {
        result.http = httpResult;
      }
    }

    result.ts = Math.floor(new Date() / 1000);

    this.wanTestResult[iface] = result.ts;

    return result;
  }

  getWanTestResult() {
    return this.wanTestResult;
  }

  async isAnyWanConnected(options = {}) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const routingPlugin = pluginLoader.getPluginInstance("routing", "global");
    if (!routingPlugin) {
      return null;
    }

    const overallStatus = routingPlugin.isAnyWanConnected();
    const wans = overallStatus && overallStatus.wans;
    if(_.isEmpty(wans)) {
      return overallStatus;
    }

    const results = {};

    if(options.live) {
      const promises = [];

      for(const name in wans) {
        let checkFunc = async () => {
          const result = await this.checkWanConnectivity(name);
          results[name] = result;
        };
        promises.push(checkFunc());
      }

      await Promise.all(promises);
    } else {
      for(const name in wans) {
        const intfPlugin = pluginLoader.getPluginInstance("interface", name);
        results[name] = intfPlugin.getWanStatus();
      }
    }

    overallStatus.wans = results;
    return overallStatus;
  }

  async getWlanAvailable(intf) {
    const iwScan = spawn('sudo', ['timeout', '20s', 'iw', 'dev', intf, 'scan'])
    iwScan.on('error', err => {
      log.error('Error running wpa_cli', err.message)
    })
    iwScan.on('exit', code => {
      if (code)
        log.warn('iw scan exited with code', code)
    })

    const rl = readline.createInterface({input: iwScan.stdout});

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
          const escaped = ln.substring(6)
          wlan.ssid = util.parseEscapedString(escaped)
          const testSet = new Set(wlan.ssid)
          if (testSet.size == 1 && testSet.values().next().value == '\x00') {
            wlan.ssid = ""
          }
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
          const splited = ln.substring(25).trim().split(' ')

          ie.suites = []
          let i = 0
          while (i < splited.length) {
            if (splited[i].includes('IEEE')) {
              ie.suites.push(splited[i]  + " " + splited[i+1])
              i += 2
            } else {
              ie.suites.push(splited[i])
              i ++
            }
          }
        }
      } catch(err) {
        log.error('Error parsing line', line, '\n', err)
      }
    }

    if (wlan) results.push(wlan)

    const selfWlanMacs = []
    const config = await this.getActiveConfig()
    const hostapdIntf = _.isObject(config.hostapd) ? Object.keys(config.hostapd) : []
    for (const intf of hostapdIntf) {
      const buffer = await fsp.readFile(r.getInterfaceSysFSDirectory(intf) + '/address')
      selfWlanMacs.push(buffer.toString().trim().toUpperCase())
    }

    return _.sortBy(results.filter(r => !selfWlanMacs.includes(r.mac)), 'channel')
  }

  // wait for scan done before parsing result if waitForScan is set to true
  async getWlansViaWpaSupplicant(waitForScan = false) {
    log.info(`getWlansViaWpaSupplicant ${waitForScan ? '' : 'without waiting result'}`)
    const pluginLoader = require('../plugins/plugin_loader.js')
    const plugins = pluginLoader.getPluginInstances('interface')
    if (!plugins) {
      log.warn('No interface found, probably still initializing')
      return []
    }
    const WLANInterfacePlugin = require('../plugins/interface/wlan_intf_plugin')
    const targetWlan = Object.values(plugins).find(p => p instanceof WLANInterfacePlugin && _.get(p, 'networkConfig.wpaSupplicant'))
    if (!targetWlan) {
      log.warn('No wlan interface configured for wpa_supplicant')
      return []
    }

    const wpaCliPath = await platform.getWpaCliBinPath();
    const ctlSocket = `${r.getRuntimeFolder()}/wpa_supplicant/${targetWlan.name}`

    // manually create a promise to return right after result parsing is finished, without waiting for process exit
    const deferred = {}
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve
      deferred.reject = reject
    })

    const wpaCli = spawn('sudo', ['timeout', '15s', `${wpaCliPath}`, '-p', ctlSocket, '-i', targetWlan.name])
    wpaCli.on('error', err => {
      log.error('Error running wpa_cli', err.message)
    })
    wpaCli.on('exit', code => {
      // if the code is 255, wpa_supplicant is probably not initialized
      if (code)
        log.warn('wpa_cli exited with code', code)

      deferred.resolve()
    })
    const results = []

    let state = 'waitForResult'

    // not using readline here as the final prompt after result won't be followed by line feed
    // readline will wait for that and cause a 5s delay
    wpaCli.stdout.on('data', data => {
      if (!data) return
      const lines = data.toString().split('\n')
      for (const line of lines) try {
        log.debug(state, line)

        // as stdin and stdout are separate streams, the order between input output streams cannot be guaranteed
        // so the state machine here is not strict and only distinguishes the result parsing state

        // wait for scan finish
        // ignore FAIL-BUSY event, the ongoing scan will emit result event anyway
        if (waitForScan && line.includes('CTRL-EVENT-SCAN-RESULTS')) {
          waitForScan = false
          log.info('scan done, getting result')
          wpaCli.stdin.writable && wpaCli.stdin.write('scan_result\n', () => {
            log.verbose('scan_result written')
          })
          continue
        }

        if (line.startsWith('bssid / frequency')) {
          log.verbose('result header seen, state => parsingResult')
          state = 'parsingResult'
          continue
        }

        switch (state) {
          case 'parsingResult':
            if (line.startsWith('>')) {
              log.verbose('prompt seen, quit')
              state = 'done'
              deferred.resolve()

              wpaCli.stdin.writable && wpaCli.stdin.write('quit\n', () => {
                log.verbose('quit written')
              })
              break
            }
            if (line.startsWith('<')) {
              log.verbose('ignoring event', line)
              break
            }

            const split = line.split('\t');

            const mac = split.shift().toUpperCase()
            const freq = parseInt(split.shift())
            const signal = parseInt(split.shift())
            const flags = split.shift().split(/[\[\]]/).filter(Boolean)

            const wlan = { mac, freq, signal, flags }

            wlan.ssid = util.parseEscapedString(split.shift())
            const testSet = new Set(wlan.ssid)
            if (testSet.size == 1 && testSet.values().next().value == '\x00') {
              wlan.ssid = ""
            }

            results.push(wlan)

            break
          case 'done':
            // do nothing
        }
      } catch(err) {
        log.error(`Error parsing line \"${line}\"\n`, err)
      }
    })

    // start scan right away
    wpaCli.stdin.write('scan\n', () => {
      log.verbose('scan wirtten')
      // only write after previous one finishes
      if (!waitForScan) {
        log.info('not waitForScan, getting result')
        wpaCli.stdin.write('scan_result\n', () => {
          log.info('scan_result written')
        })
      }
    })

    const selfWlanMacs = []
    const config = await this.getActiveConfig()
    const hostapdIntf = _.isObject(config.hostapd) ? Object.keys(config.hostapd) : []
    for (const intf of hostapdIntf) {
      const buffer = await fsp.readFile(r.getInterfaceSysFSDirectory(intf) + '/address')
      selfWlanMacs.push(buffer.toString().trim().toUpperCase())
    }

    await deferred.promise
    log.verbose('returning')

    const final = results.filter(r => !selfWlanMacs.includes(r.mac))
    log.info(`Found ${final.length} SSIDs`)
    return final
  }

  async getAvailableChannelsHostapd() {
    const HostapdPlugin = require('../plugins/hostapd/hostapd_plugin')

    const channels = await HostapdPlugin.getAvailableChannels()
    const scores = HostapdPlugin.calculateChannelScores(await this.getWlansViaWpaSupplicant(true), false)

    const result = {}
    for (const channel of channels) {
      if (!scores[channel])
        result[channel] = { score: 0 }
      else
        result[channel] = { score: _.round(scores[channel], 10) }
    }

    return result
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
    const wanIntfs = [];
    for (const ifaceType in config.interface) {
      const ifaces = config.interface[ifaceType];
      for (const name in ifaces) {
        const iface = ifaces[name];
        const wanType = iface.meta && iface.meta.type;
        if (wanType === "wan")
          wanIntfs.push(name);
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
              if ((addr.isInSubnet(addr2) || addr2.isInSubnet(addr)) && name !== i && !(wanType === "wan" && wanIntfs.includes(i)))
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

  async saveConfig(networkConfig, transaction = false) {
    const configString = JSON.stringify(networkConfig);
    if (configString) {
      await rclient.setAsync(transaction ? "sysdb:transaction:networkConfig" : "sysdb:networkConfig", configString);
      this._scheduleRedisBackgroundSave();
    }
  }

  _scheduleRedisBackgroundSave() {
    if (this.bgsaveTask)
      clearTimeout(this.bgsaveTask);
    this.bgsaveTask = setTimeout(() => {
      rclient.bgsaveAsync().then(() => exec("sync")).catch((err) => {
        log.error("Redis background save returns error", err.message);
      });
    }, 3000);
  }
}

module.exports = new NetworkConfigManager();
