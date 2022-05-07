/*    Copyright 2021 Firewalla Inc.
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
const r = require('../../util/firerouter.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const event = require('../../core/event.js');
const util = require('../../util/util.js');

const platform = require('../../platform/PlatformLoader.js').getPlatform();
const _ = require('lodash');

const wpaSupplicantServiceFileTemplate = `${r.getFireRouterHome()}/scripts/firerouter_wpa_supplicant@.template.service`;
const wpaSupplicantScript = `${r.getFireRouterHome()}/scripts/wpa_supplicant.sh`;

const APSafeFreqs = [
  2412, 2417, 2422, 2427, 2432, 2437, 2442, 2447, 2452, 2457, 2462, // NO_IR: 2467, 2472,
  5180, 5200, 5220, 5240, 5745, 5765, 5785, 5805, 5825,
]

const WLAN_BSS_EXPIRATION = 630

class WLANInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    await platform.overrideWLANKernelModule()
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/14-wpa_supplicant.conf /etc/rsyslog.d/`);
    pl.scheduleRestartRsyslog();
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/logrotate.d/wpa_supplicant /etc/logrotate.d/`);
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
    await exec("sudo systemctl daemon-reload");
  }

  static async installWpaSupplicantScript() {
    await exec(`cp ${wpaSupplicantScript} ${r.getTempFolder()}/wpa_supplicant.sh`);
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
    entries.push(`bss_expiration_age=${WLAN_BSS_EXPIRATION}`);
    // sets freq_list globally limits the frequencies being scaned
    // sets freq_list again on each network limits the frequencies being used for connection
    entries.push(`freq_list=${APSafeFreqs.join(' ')}`)

    const networks = this.networkConfig.wpaSupplicant.networks || [];
    for (const network of networks) {

      entries.push("network={");
      // freq_list set by client overrides the default AP safe setting
      !network.freq_list && entries.push(`\tfreq_list=${APSafeFreqs.join(' ')}`)
      for (const key of Object.keys(network)) {
        const value = await util.generateWpaSupplicantConfig(key, network);
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
        if (this.name === platform.getWifiClientInterface())
          essid = await exec(`sudo ${platform.getWpaCliBinPath()} -p ${r.getRuntimeFolder()}/wpa_supplicant/${this.name} -i ${this.name} status | grep "^ssid=" | awk -F= '{print $2}'`).then(result => result.stdout.trim()).catch((err) => null);
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
    state.freq = await this.getFrequency()
    state.channel = util.freqToChannel(state.freq)
    state.essid = essid;
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
        }).catch((err) => {
          this.log.error(`Failed to apply IP settings on ${this.name}`, err.message);
        });
      }
    }
  }
}

module.exports = WLANInterfacePlugin;
