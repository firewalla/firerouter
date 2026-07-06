/*    Copyright 2021-2022 Firewalla Inc.
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

const Plugin = require('../plugin.js');
const pl = require('../plugin_loader.js');
const ncm = require('../../core/network_config_mgr')
const platform = require('../../platform/PlatformLoader').getPlatform()

const hostapdServiceFileTemplate = __dirname + "/firerouter_hostapd@.template.service";
const hostapdCliServiceFileTemplate = __dirname + "/firerouter_hostapd_cli@.template.service";
const hostapdScript = __dirname + "/hostapd.sh";
const hostapdCliScript = __dirname + "/hostapd_cli.sh";

const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter');
const fsp = require('fs').promises;
const fs = require('fs');

const pluginConfig = require('./config.json');
const util = require('../../util/util');
const _ = require('lodash');

const WLANInterfacePlugin = require('../interface/wlan_intf_plugin')

const WLAN_AVAILABLE_RETRY = 3

class HostapdPlugin extends Plugin {

  onConfigChanged(changeType) {
    if (changeType === Plugin.CHANGE_NONE) {
      this._reapplyNeeded = false;
      return;
    }
    if (changeType === Plugin.CHANGE_FULL) {
      this._reapplyNeeded = true;
      return;
    }
    this._reapplyNeeded = this._reapplyNeeded || false;
    return;
  }

  static async preparePlugin() {
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/15-hostapd.conf /etc/rsyslog.d/`);
    pl.scheduleRestartRsyslog();
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/logrotate.d/hostapd /etc/logrotate.d/`);
    await this.createDirectories();
    await this.installHostapdScript();
    await this.installSystemService();
  }

  static async createDirectories() {
    await fsp.mkdir(r.getUserConfigFolder() + "/hostapd", {recursive: true}).catch((err) => {});
    await fsp.mkdir(r.getUserConfigFolder() + "/hostapd/band_2.4g", {recursive: true}).catch((err) => {});
    await fsp.mkdir(r.getUserConfigFolder() + "/hostapd/band_5g", {recursive: true}).catch((err) => {});
    await fsp.mkdir(r.getTempFolder(), {recursive: true}).catch((err) => {});
  }

  static async installSystemService() {
    let content = await fsp.readFile(hostapdServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace(/%HOSTAPD_DIRECTORY%/g, r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_hostapd@.service";
    await fsp.writeFile(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);


    // install hostapd_cli listener service
    let cli_content = await fsp.readFile(hostapdCliServiceFileTemplate, {encoding: 'utf8'});
    cli_content = cli_content.replace(/%HOSTAPD_DIRECTORY%/g, r.getTempFolder());
    const cli_targetFile = r.getTempFolder() + "/firerouter_hostapd_cli@.service";
    await fsp.writeFile(cli_targetFile, cli_content);
    await exec(`sudo cp ${cli_targetFile} /etc/systemd/system`);
  }

  static async installHostapdScript() {
    await exec(`cp ${hostapdScript} ${r.getTempFolder()}/hostapd.sh`);
    await exec(`cp ${hostapdCliScript} ${r.getTempFolder()}/hostapd_cli.sh`);
  }

  async flush() {
    // clean up hostapd_cli listener service
    await exec(`sudo systemctl stop firerouter_hostapd_cli@${this.name}`).catch((err) => {});

    await platform.disableHostapd(this.name);
  }

  async apply() {
    const parameters = pluginConfig.default ? JSON.parse(JSON.stringify(pluginConfig.default)) : {};
    const params = this.networkConfig.params || {};
    parameters.interface = this.name;
    const intfPlugin = pl.getPluginInstance("interface", this.name);
    if (!intfPlugin)
      this.fatal(`Cannot find interface plugin ${this.name}`);
    this.subscribeChangeFrom(intfPlugin);
    // if wlan is managed by apc, WLAN interface may be dynamically removed/created by hostapd using multi-bss config
    if (!platform.isWLANManagedByAPC() && await intfPlugin.isInterfacePresent() === false) {
      this.log.warn(`WLAN interface ${this.name} is not present yet`);
      return;
    }
    // primary interface will be used as main interface in hostapd config, others will be bss interfaces
    if (_.get(intfPlugin.networkConfig, "primary", false)) {
      parameters.primary = true;
    }
    if (this.networkConfig.bridge) {
      const bridgeIntfPlugin = pl.getPluginInstance("interface", this.networkConfig.bridge);
      if (!bridgeIntfPlugin)
        this.fatal(`Cannot find bridge interface plugin ${this.networkConfig.bridge}`);
      this.subscribeChangeFrom(bridgeIntfPlugin);
      if (await bridgeIntfPlugin.isInterfacePresent() === false) {
        this.log.warn(`Bridge interface ${this.networkConfig.bridge} is not present yet`);
        return;
      }
      parameters.bridge = this.networkConfig.bridge;
    }
    if (platform.wifiSD && !await r.verifyPermanentMAC(this.name)) {
      this.log.error(`Permanent MAC address of ${this.name} is not valid, ignore it`);
      return;
    }

    if (platform.wifiSD) {
      Object.assign(parameters, platform.wifiSD().getHostapdConfig())
    }

    Object.assign(parameters, params)

    if (!parameters.channel && !platform.isWLANManagedByAPC()) {
      let availableChannels = await HostapdPlugin.getAvailableChannels()

      if (parameters.chanlist) {
        // chanlist doesn't work in hostapd config, as it doesn't support acs
        // use it just to filter preset available channels here
        const chanlist = util.parseNumList(parameters.chanlist)
        const filtered = availableChannels.filter(c => chanlist.includes(c))
        if (filtered.length) {
          availableChannels = filtered
          this.log.info('chanlist set, available channels now', availableChannels)
        } else {
          this.log.error('No channels available after filtering, using default channels')
        }
        delete parameters.chanlist
      }

      let availableWLANs
      for (let i = WLAN_AVAILABLE_RETRY; i--; i > 0) try {
        availableWLANs = await ncm.getWlansViaWpaSupplicant()
        if (availableWLANs && availableWLANs.length)
          break; // stop on first successful call
        else
          this.log.warn('No wlan found, trying again...')
        await util.delay(2000)
      } catch(err) {
        this.log.warn('Error scanning WLAN, trying again after 2s ...', err.message)
        await util.delay(2000)
      }

      if (!Array.isArray(availableWLANs) || !availableWLANs.length) {
        // 5G network is preferred
        parameters.channel = availableChannels.filter(x => x >= 36)[0] || availableChannels[0]
        this.log.warn('Failed to fetch WLANs, using channel', parameters.channel)
      }
      else {
        const scores = HostapdPlugin.calculateChannelScores(availableWLANs)

        let bestChannel = undefined
        for (const ch of availableChannels) {
          // available channels should be listed in ascending order, so empty 5G channel is always preferred
          if (!bestChannel || !scores[ch] || scores[bestChannel] > scores[ch])
            bestChannel = ch
        }
        this.log.info('Best channel is', bestChannel)

        parameters.channel = bestChannel
      }
    }

    // when in wpa3 mode, no need to hash passphrase
    if (parameters.wpa3_mode) {
      // need to delete this parameter as hostapd doesn't support it
      // this parameter is only used to indicate wpa3 mode, and used only inside firerouter code
      delete parameters["wpa3_mode"];
    } else {
      if (parameters.ssid && parameters.wpa_passphrase) {
        const psk = await util.generatePSK(parameters.ssid, parameters.wpa_passphrase);
        parameters.wpa_psk = psk;
        // use hexdump for ssid
        parameters.ssid2 = util.getHexStrArray(parameters.ssid).join("");
        delete parameters["wpa_passphrase"];
        delete parameters["ssid"];
      }
    }

    const hexdumpKeys = ["wep_key0", "wep_key1", "wep_key2", "wep_key3"];
    for (const key of hexdumpKeys) {
      if (parameters.hasOwnProperty(key)) {
        parameters[key] = util.getHexStrArray(parameters[key]).join("");
      }
    }

    if (!platform.isWLANManagedByAPC()) {
      if (parameters.ht_capab && !Array.isArray(parameters.ht_capab)) delete parameters.ht_capab
      parameters.ht_capab = new Set(parameters.ht_capab)
  
      const channelConfig = pluginConfig.channel[parameters.channel]
      if (channelConfig.ht_capab) {
        channelConfig.ht_capab.default && channelConfig.ht_capab.default.forEach(c => parameters.ht_capab.add(c))
        channelConfig.ht_capab.not && channelConfig.ht_capab.not.forEach(c => parameters.ht_capab.delete(c))
      }
      channelConfig.hw_mode && (parameters.hw_mode = channelConfig.hw_mode)
      parameters.ht_capab = '[' + Array.from(parameters.ht_capab).join('][') + ']'
    }

    if ((_.isArray(parameters.ht_capab) || _.isSet(parameters.ht_capab)) && !_.isEmpty(parameters.ht_capab)) {
      parameters.ht_capab = Array.from(parameters.ht_capab).map(c => `[${c}]`).join("");
    }

    if ((_.isArray(parameters.vht_capab) || _.isSet(parameters.vht_capab)) && !_.isEmpty(parameters.vht_capab)) {
      parameters.vht_capab = Array.from(parameters.vht_capab).map(c => `[${c}]`).join("");
    }

    const vendorConfig = pluginConfig.vendor[await platform.getWlanVendor()];
    const vendorExtra = vendorConfig && vendorConfig.extra;
    if (vendorExtra) {
      Object.keys(vendorExtra).forEach(k => {
        parameters[k] = vendorExtra[k]
      })
    }
    await platform.disableHostapd(this.name);
    await exec(`sudo systemctl stop firerouter_hostapd_cli@${this.name}`).catch((err) => {}); // stop the listener first
    const iwPhy = await fsp.readFile(`/sys/class/net/${this.name}/phy80211/name`, {encoding: "utf8"}).catch((err) => null);
    if (this.networkConfig.enabled !== false) {
      await platform.enableHostapd(this.name, parameters);
      await exec(`sudo systemctl start firerouter_hostapd_cli@${this.name}`).catch((err) => {}); // start the listener after hostapd is started
      if (!platform.isWLANManagedByAPC()) {
        if (this.networkConfig.bridge) {
          // ensure wlan interface is added to bridge by hostapd, it is observed on u22 that a failed HT_SCAN request will cause the wlan being removed from bridge
          let addedToBridge = false;
          let retryCount = 0
          while (true) {
            if (retryCount >= 10) {
              this.log.error(`Failed to add ${this.name} to bridge ${this.networkConfig.bridge}`);
              break;
            }
            await util.delay(1000);
            addedToBridge = await fsp.access(`/sys/class/net/${this.networkConfig.bridge}/lower_${this.name}`, fs.constants.F_OK).then(() => true).catch((err) => false);
            if (addedToBridge) {
              this.log.info(`${this.name} is added to bridge ${this.networkConfig.bridge} by hostapd`);
              break;
            } else {
              this.log.error(`${this.name} is not added to bridge ${this.networkConfig.bridge} by hostapd, will try again`);
              await platform.enableHostapd(this.name, parameters);
              await exec(`sudo systemctl restart firerouter_hostapd_cli@${this.name}`).catch((err) => {});
              retryCount++;
            }
          }
        }
        if (iwPhy)
          await WLANInterfacePlugin.simpleWpaCommand(iwPhy, 'set autoscan exponential:2:300').catch((err) => {
            this.log.error(`Failed to set autoscan via wpa_cli on iw phy ${iwPhy} from ${this.name}`, err.message);
          });
      }
    } else {
      if (!platform.isWLANManagedByAPC()) {
        if (iwPhy)
          await WLANInterfacePlugin.simpleWpaCommand(iwPhy, 'set autoscan periodic:10').catch((err) => {
            this.log.error(`Failed to set autoscan via wpa_cli on iw phy ${iwPhy} from ${this.name}`, err.message);
          });
      }
    }
  }

  static async getAvailableChannels() {
    return pluginConfig.vendor[await platform.getWlanVendor()].channels
  }

  static calculateChannelScores(availableWLANs, withWeight = true) {
    const scores = {}

    for (const network of availableWLANs) {
      network.channel = util.freqToChannel(network.freq)

      const channelConfig = pluginConfig.channel[network.channel]
      if (!channelConfig) continue

      // ACI = Adjacent Channel Interference, this config is set to all channels being interfered
      for (const ch of channelConfig.ACI) {
        if (!scores[ch]) scores[ch] = 0
        scores[ch] += Math.pow(10, (network.signal/10)) * (withWeight ? channelConfig.weight : 1)
      }
    }

    // print debug log
    // this.log.info('channel score chart')
    // Object.keys(scores).sort((a, b) => scores[a] - scores[b]).forEach(ch => this.log.info(ch, '\t', scores[ch].toFixed(15)))

    return scores
  }
}

module.exports = HostapdPlugin;
