/*    Copyright 2019-2026 Firewalla Inc.
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
const { exec, execFile } = require('child-process-promise');
const { spawn } = require('child_process')
const readline = require('readline');
const {Address4, Address6} = require('ip-address');
const _ = require('lodash');
const uuid = require('uuid');
const pl = require('../platform/PlatformLoader.js');
const platform = pl.getPlatform();
const r = require('../util/firerouter.js');
const AsyncLock = require('async-lock');
const lock = new AsyncLock();
const fsp = require('fs').promises;
const util = require('../util/util.js');
const pluginConfig = require('../util/config.js').getConfig();

const LOCK_SWITCH_WIFI = "LOCK_SWITCH_WIFI";
const LOCK_CONFIG_RW = "LOCK_CONFIG_RW";
const WPA_ALLOWED_KEYS = new Set([
  'ssid', 'psk', 'key_mgmt', 'eap', 'identity', 'password',
  'phase1', 'phase2', 'ca_cert', 'client_cert', 'private_key',
  'bssid', 'priority', 'scan_ssid', 'proto', 'pairwise', 'group',
  'anonymous_identity', 'domain_suffix_match', 'altsubject_match',
]);
// linux caps interface names at IFNAMSIZ-1 and forbids '/' and whitespace, this is that set
// minus every shell metacharacter
const INTF_NAME_REGEX = /^[A-Za-z0-9._:@-]{1,15}$/;
// keys of the non-interface plugin sections are free form labels rather than kernel interface
// names, so keep the same charset but do not impose IFNAMSIZ on them
const PLUGIN_NAME_REGEX = /^[A-Za-z0-9._:@-]{1,64}$/;

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
          const isWPAComplate = async () => {
            return await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} status | grep wpa_state`).then(result => result.stdout.trim().endsWith("=COMPLETED")).catch((err) => false);
          };
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
          const state = await isWPAComplate();
          if (_.get(currentNetwork, 'ssid') === ssid && state === true) {
            log.info(`WPA state is already complete on current SSID ${ssid}, no need to switch`);
            done(null, []);
            return;
          }
          await platform.prepareSwitchWifi();
          // refresh interface link state to relinquish resources due to potential driver bug
          if (platform.needResetLinkBeforeSwitchWifi()) {
            await exec(`sudo ip link set ${intf} down`).catch((err) => {});
            await exec(`sudo ip link set ${intf} up`).catch((err) => {});
          }
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
            if (!WPA_ALLOWED_KEYS.has(key)) {
              done(null, [`Invalid wpa_supplicant parameter: ${key}`]);
              return;
            }
            const value = await util.generateWpaSupplicantConfig(key, params);
            // the key is allowlisted above but the value is caller supplied, keep it out of a shell
            const error = await execFile("sudo", [wpaCliPath, "-p", socketDir, "-i", intf, "set_network", String(selectedNetwork.id), key, String(value)]).then(() => null).catch((err) => err.message);
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
            const state = await isWPAComplate();
            if (state === true) {
              if (!testOnly) {
                clearInterval(checkTask);
                log.info(`WPA state complete on new SSID ${ssid}, enabling other networks`);
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
              await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} bssid_ignore clear`).catch((err) => { });
            }
            // if timeout exceeded or test only is set and connection is successful, switch back to previous setup
            if (t2 - t1 > 30 || state === true && testOnly) {
              clearInterval(checkTask);
              // refresh interface link state to relinquish resources due to potential driver bug
              if (platform.needResetLinkBeforeSwitchWifi()) {
                await exec(`sudo ip link set ${intf} down`).catch((err) => {});
                await exec(`sudo ip link set ${intf} up`).catch((err) => {});
              }
              // restore config from configuration file
              await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} reconfigure`).catch((err) => { });
              if (currentNetwork) // switch back to previous ssid
                await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} select_network ${currentNetwork.id}`).catch((err) => { });
              else // deselect ssid
                await exec(`sudo ${wpaCliPath} -p ${socketDir} -i ${intf} disable_network ${selectedNetwork.id}`).catch((err) => { });
              for (const network of networks) {
                // select_network will disable all other ssid, re-enable other ssid
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
        platform.setDFSScanState(false);
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
    // always enable ping/dns test in manual test
    options.pingTestEnabled = true;
    options.dnsTestEnabled = true;
    result = await intfPlugin.checkWanConnectivity(["1.1.1.1", "8.8.8.8", "9.9.9.9"], 1, 0.5, "github.com", options);
    if (result.dns === null) {
      result.dns = false;
    }
    // if carrier not ready, just skip http testings
    if(result.carrier) {
      const sites = options.httpSites || ["http://captive.apple.com", "http://cp.cloudflare.com", "http://clients3.google.com/generate_204"];
      // use firewalla-hosted captive check page to check status code as well as content
      let httpResult = await intfPlugin.checkHttpStatus("http://captive.firewalla.com", 200, "<html><body>FIREWALLA SUCCESS</body></html>\n");
      if (!httpResult) {
        httpResult = await Promise.any(sites.map(async (site) => {
          const result = await intfPlugin.checkHttpStatus(site);
          if(!result) {
            throw new Error("http check failed on site " + site);
          }
          return result;
        })).catch((err) => {
          log.error("Failed to check http status on all sites, err:", err.message);
        });
      }
      // return if any of them succeeds
      if (httpResult) {
        result.http = httpResult;
      }
    }
    result.ts = Math.floor(new Date() / 1000);

    this.wanTestResult[iface] = result.ts;

    if (result.active) {
      // if the wan is active after live check, immediately set the wan connectivity status to true on this wan to speed up the status update
      const event = require('./event.js');
      intfPlugin.onEvent(event.buildEvent(event.EVENT_WAN_CONN_CHECK, {intf: iface, active: true, forceState: true, failures: []}));
    }

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
    await platform.setDFSScanState(true);
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
          //  in mBm (100 * dBm) (s32)
          // * @NL80211_BSS_SIGNAL_UNSPEC: signal strength of the probe response/beacon
          // in unspecified units, scaled to 0..100 (u8)
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
    await platform.setDFSScanState(false);

    return _.sortBy(results.filter(r => !selfWlanMacs.includes(r.mac)), 'channel')
  }
  // wait for scan done before parsing result if waitForScan is set to true
  async getWlansViaWpaSupplicant(waitForScan = false) {
    if(!waitForScan) {
      // the exclusive WLAN sibling need to wait for scan result before parsing result
      waitForScan = !!platform.getExclusiveWLANSibling(platform.getAPScanInterface())
    }
    log.info(`getWlansViaWpaSupplicant ${waitForScan ? '' : 'without waiting result'}`)
    if(waitForScan) {
      await platform.waitForAPScan();
    }
    const iwScan = spawn('sudo', ['wpa_cli', '-i', platform.getAPScanInterface(), 'scan'])
    iwScan.on('error', err => {
      log.error('Error running wpa_cli', err.message)
    })
    iwScan.on('exit', code => {
      if (code)
        log.warn('wpa_cli scan exited with code', code)
    })

    const rl = readline.createInterface({input: iwScan.stdout});
    const results = []
    let wlan, ie

    for await (const line of rl) {
      try {
        if (line.startsWith('bssid / frequency / signal level / flags / ssid')) {
          continue
        }
        if (line.startsWith('BSS ')) {
          wlan && results.push(wlan)

          const mac = line.substring(4, 21).toUpperCase()
          wlan = { mac }
        }
        const ln = line.trimStart()
        if (ln.startsWith('freq:')) {
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
    return results
  }

  async setConfig(config, inTransaction = false) {
    const originConfig = await this.getActiveConfig(inTransaction);
    if (!config)
      return [new Error("Invalid config")];

    const errors = await this.validateConfig(config);
    if (errors.length) {
      return errors;
    }

    const currentConfig = await this.getActiveConfig(inTransaction);
    const currentNcid = currentConfig && currentConfig.ncid;
    if (config.ncid && config.ncid !== currentNcid) {
      return [new Error(`network config ncid ${config.ncid} is not the latest version ${currentNcid}`)];
    }

    const convertedConfig = await this.convertIntegratedAPConfig(config);
    const result = await this.tryApplyConfig(config, false);
    if (result && result.length) {
      return result;
    }

    await this.saveConfig(config, inTransaction);
    return [];
  }

  async setConfigInTransaction(config) {
    const errors = await this.validateConfig(config);
    if (errors.length) {
      return errors;
    }

    const result = await this.tryApplyConfig(config, false);
    if (result && result.length) {
      return result;
    }

    await this.saveConfig(config, true);
    return [];
  }

  async beginTransaction(config) {
    const errors = await this.validateConfig(config);
    if (errors.length) {
      return errors;
    }
    await this.saveConfig(config, true);
    return [];
  }

  async commitTransaction() {
    const config = await this.getActiveConfig(true);
    if (!config)
      return [new Error("No transaction in progress")];

    const errors = await this.validateConfig(config);
    if (errors.length) {
      return errors;
    }

    const result = await this.tryApplyConfig(config, false);
    if (result && result.length) {
      return result;
    }

    await this.saveConfig(config, false);
    return [];
  }

  async revertTransaction() {
    await this.deleteTransactionConfig();
    return [];
  }

  async getConfig(inTransaction = false) {
    let config = null;
    if (inTransaction) {
      config = await this.getTransactionConfig();
    } else {
      config = await this.getActiveConfig();
    }

    return config;
  }

  async saveConfig(networkConfig, inTransaction = false) {
    if (!networkConfig)
      throw new Error("Invalid config");
    if (!inTransaction && !networkConfig.ncid) {
      networkConfig.ncid = util.generateUUID();
    }

    const key = inTransaction ? "sysdb:transaction:networkConfig" : "sysdb:networkConfig";
    await rclient.setAsync(key, JSON.stringify(networkConfig));
    if (!inTransaction) {
      await util.bgsaveRedis();
    }
  }

  async getActiveConfig(inTransaction = false) {
    const key = inTransaction ? "sysdb:transaction:networkConfig" : "sysdb:networkConfig";
    const config = await rclient.getAsync(key);
    if (config) {
      return JSON.parse(config);
    }

    return null;
  }

  async getDefaultConfig() {
    const configFile = platform.getDefaultNetworkJsonFile();
    const config = await fsp.readFile(configFile);
    return JSON.parse(config);
  }

  async deleteTransactionConfig() {
    await rclient.delAsync("sysdb:transaction:networkConfig");
  }

  async getTransactionConfig() {
    const config = await rclient.getAsync("sysdb:transaction:networkConfig");
    if (config) {
      return JSON.parse(config);
    }

    return null;
  }

  async validateConfig(config) {
    const errors = [];
    if (!config || !_.isObject(config)) {
      return [new Error("Invalid config")];
    }

    if (config.ncid) {
      if (typeof config.ncid !== 'string') {
        errors.push(new Error("Invalid network config ncid"));
      }
    }

    for (const section of Object.keys(config)) {
      if (section === "ncid" || section === "plugins") {
        continue;
      }

      if (!_.isObject(config[section])) {
        errors.push(new Error(`Invalid config section ${section}`));
        continue;
      }

      for (const name of Object.keys(config[section])) {
        if (!INTF_NAME_REGEX.test(name) && !PLUGIN_NAME_REGEX.test(name)) {
          errors.push(new Error(`Invalid config name ${name}`));
        }

        const iface = config[section][name];
        if (!_.isObject(iface)) {
          errors.push(new Error(`Invalid config for ${section}.${name}`));
          continue;
        }

        if (section === "interface") {
          if (iface.meta && iface.meta.type && !["wan", "lan"].includes(iface.meta.type)) {
            errors.push(new Error(`Invalid interface type ${iface.meta.type} for ${name}`));
          }

          if (iface.meta && iface.meta.uuid && typeof iface.meta.uuid !== 'string') {
            errors.push(new Error(`Invalid interface uuid for ${name}`));
          }

          if (!iface.meta) {
            iface.meta = {};
          }

          if (!iface.meta.uuid) {
            iface.meta.uuid = uuid.v4();
          }
        }
      }
    }

    return errors;
  }

  async getWanByName(name) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance("interface", name);
    if (!plugin)
      return null;
    return plugin;
  }

  async getLanByName(name) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance("interface", name);
    if (!plugin)
      return null;
    return plugin;
  }

  async getInterfaceState(name) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance("interface", name);
    if (!plugin)
      return null;
    return await plugin.state();
  }

  async getNetworkConfig() {
    return await this.getActiveConfig();
  }

  async getNetworkConfigForTransaction() {
    return await this.getTransactionConfig();
  }

  async withConfigReadLock(func) {
    return lock.acquire(LOCK_CONFIG_RW, async () => {
      log.info("Config RW Lock acquired");
      return func();
    }).finally(() => {
      log.info("Config RW Lock released");
    });
  }

  async withConfigWriteLock(func) {
    return lock.acquire(LOCK_CONFIG_RW, async () => {
      log.info("Config RW Lock acquired");
      return func();
    }).finally(() => {
      log.info("Config RW Lock released");
    });
  }

  async tryApplyConfigWithRWLock(config, dryRun = false) {
    return await lock.acquire(LOCK_CONFIG_RW, async () => {
      const errors = await this.tryApplyConfig(config, dryRun);
      return errors;
    }).catch((err) => {
      return [err.message];
    });
  }

  async tryApplyConfig(config, dryRun = false) {
    const currentConfig = (await this.getActiveConfig()) || (await this.getDefaultConfig());
    // convert new config to integrated AP config
    const convertedConfig = await this.convertIntegratedAPConfig(config).catch((err) => {
      log.error(`Failed to convert effective config`, err.message);
      return config;
    });
    const errors = await ns.setup(convertedConfig, dryRun);
    if (errors && errors.length != 0) {
      log.error("Failed to apply network config", errors);
      if (!dryRun) {
        // convert current config to integrated AP config
        const convertedCurrentConfig = await this.convertIntegratedAPConfig(currentConfig).catch((err) => {
          log.error(`Failed to convert effective config`, err.message);
          return currentConfig;
        });
        await ns.setup(convertedCurrentConfig).catch((err) => {
          log.error("Failed to rollback network config", err);
        });
      }
    }
    return errors;
  }

  async convertIntegratedAPConfig(config) {
    if (!platform.isWLANManagedByAPC()) {
      return config;
    }
    const fwapcExecPath = r.getFwapcExecPath();
    const tempFile = `/dev/shm/fr_orig_config_${util.generateUUID()}.json`;
    await fsp.writeFile(tempFile, JSON.stringify(config));
    // turn off log output on stdout to avoid inteference with JSON parsing
    const response = await exec(`FW_LOG=OFF ${fwapcExecPath} ciap ${tempFile}`);
    const data = JSON.parse(response.stdout);
    await fsp.unlink(tempFile).catch((err) => {});
    log.debug(`Converted effective config`, data);
    return data;
  }

  async validateNcidOrReqId(networkConfig, inTransaction = false, skipNcid = false) {
    const originConfig = await this.getActiveConfig(inTransaction);
    if (!originConfig) {
      return [new Error("No active network config")];
    }

    if (!skipNcid && networkConfig.ncid !== originConfig.ncid) {
      return [new Error(`network config ncid ${networkConfig.ncid} is not the latest version ${originConfig.ncid}`)];
    }

    if (networkConfig.reqId && originConfig.reqId && networkConfig.reqId !== originConfig.reqId) {
      return [new Error(`network config reqId ${networkConfig.reqId} is not the latest version ${originConfig.reqId}`)];
    }

    return [];
  }

  async getStatus() {
    const result = {};
    const pluginLoader = require('../plugins/plugin_loader.js');
    result.interfaces = {};
    const interfaces = await this.getInterfaces();
    for (const iface of interfaces) {
      result.interfaces[iface.name] = iface;
    }
    result.wans = await this.getWANs();
    result.lans = await this.getLANs();
    result.apc = {
      managed: platform.isWLANManagedByAPC(),
      country: platform.getCountry()
    };
    return result;
  }

  async getInterfaceSimpleByName(name) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance('interface', name);
    if (!plugin) {
      return { carrier: 0 };
    }
    return { carrier: (await plugin.readyToConnect().catch(() => false)) ? 1 : 0 };
  }

  async getInterfacesSimple() {
    const interfaces = await this.getInterfaces();
    return interfaces.map(iface => ({
      name: iface.name,
      carrier: iface.carrier
    }));
  }

  async getInterfaceConfig(name) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance('interface', name);
    if (!plugin) {
      return null;
    }
    return plugin.networkConfig;
  }

  async validateInterfaceName(name) {
    if (!INTF_NAME_REGEX.test(name)) {
      return false;
    }
    return true;
  }

  async validatePluginName(name) {
    if (!PLUGIN_NAME_REGEX.test(name)) {
      return false;
    }
    return true;
  }

  async getDHCPLeaseInfo(iface) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance("dhcp", iface);
    if (!plugin)
      return null;
    return plugin.getDHCPLeaseInfo();
  }

  async renewDHCPLease(iface) {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance("interface", iface);
    if (!plugin)
      return null;
    return plugin.renewDHCPLease();
  }

  async getDNSConfig() {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance("dns", "global");
    if (!plugin)
      return null;
    return plugin.networkConfig;
  }

  async getRoutingConfig() {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance("routing", "global");
    if (!plugin)
      return null;
    return plugin.networkConfig;
  }

  async getNATConfig() {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance("nat", "global");
    if (!plugin)
      return null;
    return plugin.networkConfig;
  }

  async getHostapdConfig() {
    const pluginLoader = require('../plugins/plugin_loader.js');
    const plugin = pluginLoader.getPluginInstance("hostapd", "global");
    if (!plugin)
      return null;
    return plugin.networkConfig;
  }

  async getConfigStatus() {
    const config = await this.getActiveConfig();
    if (!config) {
      return null;
    }
    return {
      ncid: config.ncid,
      reqId: config.reqId
    };
  }

  async getConfigDiff(config) {
    const currentConfig = await this.getActiveConfig();
    if (!currentConfig) {
      return null;
    }

    const diff = {};
    for (const section of Object.keys(config || {})) {
      if (section === "ncid" || section === "reqId") {
        continue;
      }

      const currentSection = currentConfig[section] || {};
      const newSection = config[section] || {};
      diff[section] = {};

      for (const name of Object.keys(newSection)) {
        if (!_.isEqual(currentSection[name], newSection[name])) {
          diff[section][name] = {
            current: currentSection[name],
            next: newSection[name]
          };
        }
      }

      for (const name of Object.keys(currentSection)) {
        if (!Object.prototype.hasOwnProperty.call(newSection, name)) {
          diff[section][name] = {
            current: currentSection[name],
            next: undefined
          };
        }
      }
    }

    return diff;
  }

  async getConfigNcid() {
    const config = await this.getActiveConfig();
    return config && config.ncid;
  }

  async getConfigReqId() {
    const config = await this.getActiveConfig();
    return config && config.reqId;
  }

  async setReqId(config, reqId) {
    if (!config || typeof config !== 'object') {
      return;
    }
    config.reqId = reqId;
  }

  async clearReqId(config) {
    if (!config || typeof config !== 'object') {
      return;
    }
    delete config.reqId;
  }

  async getActiveNetworkConfig() {
    return await this.getActiveConfig();
  }

  async getTransactionNetworkConfig() {
    return await this.getTransactionConfig();
  }

  async applyCurrentConfig() {
    const config = await this.getActiveConfig();
    if (!config) {
      return [new Error("No active network config")];
    }
    return await this.tryApplyConfig(config, false);
  }

  async getConfigSource(inTransaction = false) {
    return inTransaction ? "transaction" : "active";
  }

  async getNetworkConfigWithSource(inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    return {
      source: await this.getConfigSource(inTransaction),
      config
    };
  }

  async saveTransactionConfig(config) {
    return await this.saveConfig(config, true);
  }

  async clearTransactionConfig() {
    return await this.deleteTransactionConfig();
  }

  async getCurrentConfig() {
    return await this.getActiveConfig();
  }

  async getDefaultNetworkConfig() {
    return await this.getDefaultConfig();
  }

  async resetToDefaultConfig() {
    const config = await this.getDefaultConfig();
    return await this.tryApplyConfig(config, false);
  }

  async hasTransactionConfig() {
    const config = await this.getTransactionConfig();
    return !!config;
  }

  async getNetworkConfigNcid(inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    return config && config.ncid;
  }

  async getNetworkConfigReqId(inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    return config && config.reqId;
  }

  async removeTransactionConfig() {
    return await this.deleteTransactionConfig();
  }

  async getEffectiveConfig(inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    return config || await this.getDefaultConfig();
  }

  async getEffectiveConfigNcid(inTransaction = false) {
    const config = await this.getEffectiveConfig(inTransaction);
    return config && config.ncid;
  }

  async getEffectiveConfigReqId(inTransaction = false) {
    const config = await this.getEffectiveConfig(inTransaction);
    return config && config.reqId;
  }

  async getConfigExists(inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    return !!config;
  }

  async getConfigSourceValue(inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    return config ? (inTransaction ? "transaction" : "active") : "default";
  }

  async getWanNames() {
    const wans = await this.getWANs();
    return wans.map(wan => wan.name);
  }

  async getLanNames() {
    const lans = await this.getLANs();
    return lans.map(lan => lan.name);
  }

  async getInterfaceNames() {
    const interfaces = await this.getInterfaces();
    return interfaces.map(iface => iface.name);
  }

  async getInterfaceNamesByType(type) {
    const interfaces = await this.getInterfaces();
    return interfaces.filter(iface => _.get(iface, 'config.meta.type') === type).map(iface => iface.name);
  }

  async getWansAndLans() {
    return {
      wans: await this.getWANs(),
      lans: await this.getLANs()
    };
  }

  async getInterfaceSummary(name) {
    const iface = await this.getInterface(name);
    if (!iface) {
      return null;
    }
    return {
      name: iface.name,
      carrier: iface.carrier,
      state: iface.state
    };
  }

  async getAllInterfaceStates() {
    const interfaces = await this.getInterfaces();
    const states = {};
    for (const iface of interfaces) {
      states[iface.name] = iface.state;
    }
    return states;
  }

  async validateRequestConfig(config, inTransaction = false) {
    const errors = await this.validateConfig(config);
    if (errors.length) {
      return errors;
    }
    return await this.validateNcidOrReqId(config, inTransaction);
  }

  async updateConfig(config, inTransaction = false) {
    return await this.setConfig(config, inTransaction);
  }

  async applyConfig(config, dryRun = false) {
    return await this.tryApplyConfigWithRWLock(config, dryRun);
  }

  async getPluginConfig() {
    return pluginConfig;
  }

  async getPlatformCountry() {
    return platform.getCountry();
  }

  async getFwapcExecPath() {
    return r.getFwapcExecPath();
  }

  async getWlanManagedByAPC() {
    return platform.isWLANManagedByAPC();
  }

  async getPlatformModel() {
    return platform.getPlatformModel();
  }

  async getPlatformVersion() {
    return platform.getPlatformVersion();
  }

  async getRuntimeFolder() {
    return r.getRuntimeFolder();
  }

  async getFirerouterHome() {
    return r.getFireRouterHome();
  }

  async getFirewallaHome() {
    return r.getFirewallaHome();
  }

  async getNodeBinPath() {
    return r.getNodeBinPath();
  }

  async getDnsmasqBinPath() {
    return r.getDnsmasqBinPath();
  }

  async getWpaCliBinPath() {
    return platform.getWpaCliBinPath();
  }

  async getDefaultNetworkJsonFile() {
    return platform.getDefaultNetworkJsonFile();
  }

  async getConfigFile(configPath) {
    const filePath = r.resolve(configPath);
    return await fsp.readFile(filePath);
  }

  async writeConfigFile(configPath, content) {
    const filePath = r.resolve(configPath);
    await fsp.writeFile(filePath, content);
  }

  async deleteConfigFile(configPath) {
    const filePath = r.resolve(configPath);
    await fsp.unlink(configPath);
  }

  async fileExists(configPath) {
    try {
      await fsp.access(r.resolve(configPath));
      return true;
    } catch (err) {
      return false;
    }
  }

  async createConfigDirectory(configPath) {
    await fsp.mkdir(r.resolve(configPath), {recursive: true});
  }

  async getPlatformConfig() {
    return platform;
  }

  async getRuntimeInfo() {
    return {
      firerouterHome: r.getFireRouterHome(),
      firewallaHome: r.getFirewallaHome(),
      runtimeFolder: r.getRuntimeFolder(),
      nodeBinPath: r.getNodeBinPath()
    };
  }

  async getHealthStatus() {
    return {
      config: await this.getConfigStatus(),
      interfaces: await this.getInterfacesSimple(),
      wans: await this.getWANs(),
      lans: await this.getLANs()
    };
  }

  async getVersionInfo() {
    return {
      platform: await this.getPlatformModel(),
      version: await this.getPlatformVersion()
    };
  }

  async getSystemInfo() {
    return {
      runtime: await this.getRuntimeInfo(),
      version: await this.getVersionInfo(),
      platformCountry: await this.getPlatformCountry()
    };
  }

  async getNetworkOverview() {
    return {
      config: await this.getActiveConfig(),
      interfaces: await this.getInterfaces(),
      wans: await this.getWANs(),
      lans: await this.getLANs()
    };
  }

  async getApplyStatus() {
    return {
      switchingWifi: this.isSwitchingWifi(),
      hasTransaction: await this.hasTransactionConfig()
    };
  }

  async getConfigValidationResult(config) {
    const errors = await this.validateConfig(config);
    return {
      valid: errors.length === 0,
      errors
    };
  }

  async validateAndApplyConfig(config, dryRun = false) {
    const errors = await this.validateConfig(config);
    if (errors.length) {
      return errors;
    }
    return await this.tryApplyConfigWithRWLock(config, dryRun);
  }

  async getCurrentAndDefaultConfig() {
    return {
      current: await this.getActiveConfig(),
      default: await this.getDefaultConfig()
    };
  }

  async getConfigForApply(dryRun = false) {
    return dryRun ? null : await this.getActiveConfig();
  }

  async getReadonlyConfig() {
    return await this.getActiveConfig();
  }

  async isConfigApplied(config) {
    const current = await this.getActiveConfig();
    return _.isEqual(current, config);
  }

  async isTransactionConfigApplied() {
    const config = await this.getTransactionConfig();
    const active = await this.getActiveConfig();
    return _.isEqual(config, active);
  }

  async getConfigMetadata(config) {
    return {
      ncid: config && config.ncid,
      reqId: config && config.reqId
    };
  }

  async getConfigMeta(config) {
    return this.getConfigMetadata(config);
  }

  async validateConfigMetadata(config) {
    if (!config || typeof config !== 'object') {
      return [new Error("Invalid config")];
    }
    return [];
  }

  async ensureConfigNcid(config) {
    if (!config.ncid) {
      config.ncid = util.generateUUID();
    }
    return config;
  }

  async ensureConfigReqId(config, reqId) {
    config.reqId = reqId;
    return config;
  }

  async getConfigSummary() {
    const config = await this.getActiveConfig();
    if (!config) {
      return null;
    }
    return {
      ncid: config.ncid,
      reqId: config.reqId,
      sections: Object.keys(config)
    };
  }

  async getConfigSection(section, inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    return config && config[section];
  }

  async getConfigEntry(section, name, inTransaction = false) {
    const sectionConfig = await this.getConfigSection(section, inTransaction);
    return sectionConfig && sectionConfig[name];
  }

  async hasConfigSection(section, inTransaction = false) {
    const sectionConfig = await this.getConfigSection(section, inTransaction);
    return !!sectionConfig;
  }

  async hasConfigEntry(section, name, inTransaction = false) {
    const entry = await this.getConfigEntry(section, name, inTransaction);
    return !!entry;
  }

  async getConfigSections(inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    return config ? Object.keys(config) : [];
  }

  async getConfigEntries(section, inTransaction = false) {
    const sectionConfig = await this.getConfigSection(section, inTransaction);
    return sectionConfig ? Object.keys(sectionConfig) : [];
  }

  async getConfigEntryNames(section, inTransaction = false) {
    return await this.getConfigEntries(section, inTransaction);
  }

  async getConfigSectionExists(section, inTransaction = false) {
    return await this.hasConfigSection(section, inTransaction);
  }

  async getConfigEntryExists(section, name, inTransaction = false) {
    return await this.hasConfigEntry(section, name, inTransaction);
  }

  async getNetworkConfigSections(inTransaction = false) {
    return await this.getConfigSections(inTransaction);
  }

  async getNetworkConfigEntries(section, inTransaction = false) {
    return await this.getConfigEntries(section, inTransaction);
  }

  async getNetworkConfigEntryNames(section, inTransaction = false) {
    return await this.getConfigEntryNames(section, inTransaction);
  }

  async getNetworkConfigEntry(section, name, inTransaction = false) {
    return await this.getConfigEntry(section, name, inTransaction);
  }

  async getConfigValue(path, inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    return _.get(config, path);
  }

  async setConfigValue(path, value, inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    if (!config) {
      return false;
    }
    _.set(config, path, value);
    await this.saveConfig(config, inTransaction);
    return true;
  }

  async deleteConfigValue(path, inTransaction = false) {
    const config = await this.getConfig(inTransaction);
    if (!config) {
      return false;
    }
    _.unset(config, path);
    await this.saveConfig(config, inTransaction);
    return true;
  }

  async cloneConfig(config) {
    return _.cloneDeep(config);
  }

  async compareConfigs(a, b) {
    return _.isEqual(a, b);
  }

  async isDryRunSupported() {
    return true;
  }

  async shutdown() {
    this.wanTestResult = {};
  }
}

module.exports = new NetworkConfigManager();
