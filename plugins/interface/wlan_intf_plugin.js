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

const InterfaceBasePlugin = require('./intf_base_plugin.js');

const exec = require('child-process-promise').exec;
const pl = require('../plugin_loader.js');
const ncm = require('../../core/network_config_mgr')
const r = require('../../util/firerouter.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const event = require('../../core/event.js');
const util = require('../../util/util.js');

const platform = require('../../platform/PlatformLoader.js').getPlatform();
const GoldPlatform = require('../../platform/gold/GoldPlatform')
const _ = require('lodash');

const wpaSupplicantServiceFileTemplate = `${r.getFireRouterHome()}/scripts/firerouter_wpa_supplicant@.template.service`;
const wpaSupplicantScript = `${r.getFireRouterHome()}/scripts/wpa_supplicant.sh`;

const APSafeFreqs = [
  2412, 2417, 2422, 2427, 2432, 2437, 2442, 2447, 2452, 2457, 2462, // NO_IR: 2467, 2472,
  5180, 5200, 5220, 5240, 5745, 5765, 5785, 5805, 5825,
]

const defaultGlobalConfig = {
  bss_expiration_age: 630,
  bss_expiration_scan_count: 5,

  // sets freq_list globally limits the frequencies being scaned
  freq_list: APSafeFreqs,
}

const defaultNetworkConfig = {
  // sets freq_list again on each network limits the frequencies being used for connection
  freq_list: APSafeFreqs,
}

class WLANInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    await platform.overrideWLANKernelModule();
    await platform.reloadWLANKernelModule();
    await platform.installWLANTools();
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/14-wpa_supplicant.conf /etc/rsyslog.d/`);
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/13-rtw.conf /etc/rsyslog.d/`);
    pl.scheduleRestartRsyslog();
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/logrotate.d/wpa_supplicant /etc/logrotate.d/`);
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/logrotate.d/rtw /etc/logrotate.d/`);
    // make crontab persistent, this actually depends on Firewalla code, but that's fine cuz
    // update_crontab.sh exists in both Gold and Purple's base image, and covers ~/.firewalla/config/crontab/
    await exec(`mkdir -p ${r.getFirewallaUserConfigFolder()}/crontab`)
    await exec(`echo "*/10 * * * * sudo logrotate /etc/logrotate.d/rtw" > ${r.getFirewallaUserConfigFolder()}/crontab/rtw-logrotate`)
    await exec(`${r.getFirewallaHome()}/scripts/update_crontab.sh`).catch(()=>{})
    await this.createDirectories();
    await this.installWpaSupplicantScript();
    await this.installSystemService();
  }

  static async createDirectories() {
    await exec(`mkdir -p ${r.getUserConfigFolder()}/wpa_supplicant`).catch((err) => {});
    await exec(`mkdir -p ${r.getRuntimeFolder()}/wpa_supplicant`).catch((err) => {});
    await exec(`mkdir -p ${r.getTempFolder()}`).catch((err) => {});
  }

  static async installSystemService() {
    let content = await fs.readFileAsync(wpaSupplicantServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace(/%WPA_SUPPLICANT_DIRECTORY%/g, r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_wpa_supplicant@.service";
    await fs.writeFileAsync(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);
  }

  static async installWpaSupplicantScript() {
    await exec(`cp ${wpaSupplicantScript} ${r.getTempFolder()}/wpa_supplicant.sh`);
  }

  static async getInstanceWithWpaSupplicant(iwPhy) {
    const wpas = Object.values(pl.getPluginInstances("interface"))
      .filter(p => p instanceof WLANInterfacePlugin && _.get(p, 'networkConfig.wpaSupplicant'))
    let wpa = null;
    // find the wlan interface with the same iw phy as the input iwPhy
    for (const iface of wpas) {
      const phy = await fs.readFileAsync(`/sys/class/net/${iface.name}/phy80211/name`, {encoding: "utf8"}).catch((err) => null);
      if (phy == iwPhy) {
        wpa = iface;
        break;
      }
    }
    if (!wpa || await wpa.isInterfacePresent() == false) {
      console.error(`No wlan interface configured with wpa_supplicant`);
      return null
    }
    return wpa
  }

  static async simpleWpaCommand(iwPhy,  paramString) {
    if (!_.isString(paramString) || !paramString.trim().length)
      throw new Error('Empty command')

    const instance = await WLANInterfacePlugin.getInstanceWithWpaSupplicant(iwPhy)
    if (instance) {
      const wpaCliPath = await platform.getWpaCliBinPath();
      const ctlSocket = `${r.getRuntimeFolder()}/wpa_supplicant/${instance.name}`
      return exec(`sudo ${wpaCliPath} -p ${ctlSocket} -i ${instance.name} ${paramString}`)
    }
  }

  async readyToConnect() {
    const carrier = await this.carrierState();
    if (carrier !== "1") {
      return false;
    }

    const operstate = await this.operstateState();
    if (operstate !== "up") {
      return false;
    }

    const ipv4Addrs = await this.getIPv4Addresses();
    const ipv6Addrs = await this.getRoutableIPv6Addresses();

    if (_.isEmpty(ipv4Addrs) && _.isEmpty(ipv6Addrs)) {
      return false;
    }

    return true;
  }

  async flush() {
    await super.flush();

    if (this.networkConfig && this.networkConfig.baseIntf) {
      const baseIntf = this.networkConfig.baseIntf;
      const basePhy = await exec(`readlink -f /sys/class/net/${baseIntf}/phy80211`, {encoding: "utf8"}).then(result => result.stdout.trim()).catch((err) => null);
      const myPhy = await exec(`readlink -f /sys/class/net/${this.name}/phy80211`, {encoding: "utf8"}).then(result => result.stdout.trim()).catch((err) => null);
      if (basePhy && myPhy && basePhy === myPhy)
        await exec(`sudo iw dev ${this.name} del`).catch((err) => {});
      else
        this.log.warn(`${this.name} and ${baseIntf} are not pointing to the same wifi phy, interface ${this.name} will not be deleted`);
    }

    if (this.networkConfig && this.networkConfig.wpaSupplicant) {
      await exec(`sudo systemctl stop firerouter_wpa_supplicant@${this.name}`).catch((err) => {});
      await fs.unlinkAsync(this._getWpaSupplicantConfigPath()).catch((err) => {});
    }
  }

  _getWpaSupplicantConfigPath() {
    return `${r.getUserConfigFolder()}/wpa_supplicant/${this.name}.conf`;
  }

  async writeConfigFile() {
    const entries = []
    entries.push(`ctrl_interface=DIR=${r.getRuntimeFolder()}/wpa_supplicant/${this.name}`);

    const wpaSupplicant = JSON.parse(JSON.stringify(this.networkConfig.wpaSupplicant || {}))
    const networks = wpaSupplicant.networks || [];
    delete wpaSupplicant.networks

    const globalConfig = Object.assign({}, defaultGlobalConfig)
    const iwPhy = await fs.readFileAsync(`/sys/class/net/${this.name}/phy80211/name`, {encoding: "utf8"}).catch((err) => null);
    if (iwPhy) {
       // use exponential scan only if WWLAN is configured
      const frcfg = await ncm.getActiveConfig()
      if (_.isObject(frcfg.hostapd) && Object.keys(frcfg.hostapd).length) {
        for (const iface of Object.keys(frcfg.hostapd)) {
          const phy = await fs.readFileAsync(`/sys/class/net/${iface}/phy80211/name`, {encoding: "utf8"}).catch((err) => null);
          if (phy == iwPhy) {
            Object.assign(globalConfig, {  autoscan: 'exponential:2:300' });
            break;
          }
        }
      }
    }
    // override globalConfig with dynamically-defined configuration
    Object.assign(globalConfig, wpaSupplicant);
    for (const key in globalConfig) {
      const value = await util.generateWpaSupplicantConfig(key, globalConfig);
      entries.push(`${key}=${value}`);
    }

    for (const network of networks) {
      entries.push("network={");
      const networkConfig = Object.assign({}, defaultNetworkConfig, network)
      for (const key in networkConfig) {
        const value = await util.generateWpaSupplicantConfig(key, networkConfig);
        entries.push(`\t${key}=${value}`);
      }
      entries.push("}\n");
    }

    await fs.writeFileAsync(this._getWpaSupplicantConfigPath(), entries.join('\n'));
  }

  async createInterface() {
    const ifaceExists = await exec(`ip link show dev ${this.name}`).then(() => true).catch((err) => false);
    if (!ifaceExists) {
      if (this.networkConfig.baseIntf) {
        const baseIntf = this.networkConfig.baseIntf;
        const baseIntfPlugin = pl.getPluginInstance("interface", baseIntf);
        if (baseIntfPlugin) {
          this.subscribeChangeFrom(baseIntfPlugin);
          if (await baseIntfPlugin.isInterfacePresent() === false) {
            this.log.warn(`Base interface ${baseIntf} is not present yet`);
            return false;
          }
        } else {
          this.fatal(`Lower interface plugin not found ${baseIntf}`);
        }
        const type = this.networkConfig.type || "managed";
        await exec(`sudo iw dev ${baseIntf} interface add ${this.name} type ${type}`);
      }
    } else {
      this.log.warn(`Interface ${this.name} already exists`);
    }

    // refresh interface state in case something is not relinquished in driver
    await exec(`sudo ip link set ${this.name} down`).catch((err) => {});
    await exec(`sudo ip link set ${this.name} up`).catch((err) => {});

    if (platform instanceof GoldPlatform && await platform.getWlanVendor() == '8821cu') {
      await exec('echo 4 > /proc/net/rtl8821cu/log_level').catch(()=>{})
    }

    if (this.networkConfig.wpaSupplicant) {

      await this.writeConfigFile()

      if (this.networkConfig.enabled) {
        await exec(`sudo systemctl start firerouter_wpa_supplicant@${this.name}`).catch((err) => {
          this.log.error(`Failed to start firerouter_wpa_supplicant on $${this.name}`, err.message);
        });
      } else {
        await exec(`sudo systemctl stop firerouter_wpa_supplicant@${this.name}`).catch((err) => {});
      }
    }

    return true;
  }

  async getEssid() {
    const carrier = await this.carrierState();
    const operstate = await this.operstateState();
    let essid = null;
    // iwgetid will still return the essid during authentication process, when operstate is dormant
    // need to make sure the authentication is passed and operstate is up
    if (carrier === "1" && operstate === "up") {
      const iwgetidAvailable = await exec("which iwgetid").then(() => true).catch(() => false);
      if (iwgetidAvailable) {
        essid = await exec(`iwgetid -r ${this.name}`, {encoding: "utf8"}).then(result => result.stdout.trim()).catch((err) => null);
      } else {
        essid = await exec(`iw dev ${this.name} info | grep "ssid "`)
          .then(result => {
            const line = result.stdout.trim();
            return line.substring(line.indexOf("ssid ") + 5);
          }).catch(() => null);
        if (essid && essid.length)
          essid = util.parseEscapedString(essid);
      }
    }
    return essid;
  }

  async getFrequency() {
    const result = await exec(`iwconfig ${this.name} | grep Frequency | tr -s ' ' | cut -d' ' -f3`).catch(() => {})
    if (!result) return null
    return Number(result.stdout.substring(10)) * 1000
  }

  async state() {
    const state = await super.state();
    const vendor = await platform.getWlanVendor().catch( err => {this.log.error("Failed to get WLAN vendor:",err.message); return '';} );
    const essid = await this.getEssid();
    state.essid = essid;
    state.carrier = (this.isWAN()
      ? await this.readyToConnect().catch(() => false)
      : state.essid && state.carrier
    ) ? 1 : 0
    if (state.carrier && state.essid) {
      state.freq = await this.getFrequency()
      state.channel = util.freqToChannel(state.freq)
    }
    state.vendor = vendor;
    return state;
  }

  onEvent(e) {
    super.onEvent(e);
    const eventType = event.getEventType(e);
    if (eventType === event.EVENT_WPA_CONNECTED) {
      // need to re-check connectivity status after wifi is switched
      this.setPendingTest(true);
      if (this.isDHCP()) {
        this.flushIP().then(async () => {
          await this.applyIpSettings();
          await this.applyDnsSettings();
          await this.changeRoutingTables();
          if (this.isWAN()) {
            this._wanStatus = {};
            await this.updateRouteForDNS();
            await this.markOutputConnection();
          }
          await pl.publishIfaceChangeApplied();
        }).catch((err) => {
          this.log.error(`Failed to apply IP settings on ${this.name}`, err.message);
        });
      }
    }
  }
}

module.exports = WLANInterfacePlugin;
