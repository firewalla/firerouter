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
const PurplePlatform = require('../../platform/purple/PurplePlatform')
const _ = require('lodash');

const wpaSupplicantServiceFileTemplate = `${r.getFireRouterHome()}/scripts/firerouter_wpa_supplicant@.template.service`;
const wpaSupplicantScript = `${r.getFireRouterHome()}/scripts/wpa_supplicant.sh`;

const WLAN_BSS_EXPIRATION = 630

class WLANInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    await this.overrideKernelModule()
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/14-wpa_supplicant.conf /etc/rsyslog.d/`);
    pl.scheduleRestartRsyslog();
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/logrotate.d/wpa_supplicant /etc/logrotate.d/`);
    await this.createDirectories();
    await this.installWpaSupplicantScript();
    await this.installSystemService();
  }

  static async overrideKernelModule() {
    if (platform instanceof PurplePlatform && await platform.getWlanVendor() == '88x2cs') {
      await exec(`sudo cp ${platform.getBinaryPath()}/88x2cs.ko /lib/modules/4.9.241-firewalla/kernel/drivers/net/wireless/realtek/rtl8822cs/`)
      await exec('sudo rmmod 88x2cs')
      await exec('sudo modprobe 88x2cs')
    }
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

  async writeConfigFile(availableWLANs) {
    const entries = []
    entries.push(`ctrl_interface=DIR=${r.getRuntimeFolder()}/wpa_supplicant/${this.name}`);
    entries.push(`bss_expiration_age=${WLAN_BSS_EXPIRATION}`);

    const networks = this.networkConfig.wpaSupplicant.networks || [];
    for (const network of networks) {
      const prioritizedNetworks = (availableWLANs || [])
        .filter(n => n.ssid == network.ssid && n.freq > 5000 && n.signal > -80)
      if (prioritizedNetworks.length) {
        entries.push("network={");
        for (const key of Object.keys(network)) {
          if (key == 'priority')
            entries.push(`\tpriority=${network[key]+1}`);
          else {
            const value = await util.generateWpaSupplicantConfig(key, network);
            entries.push(`\t${key}=${value}`);
          }
        }
        if (!'priority' in network) {
          entries.push(`\tpriority=1`);
        }
        entries.push(`\tfreq_list=${prioritizedNetworks.map(p => p.freq).join(' ')}`);
        entries.push("}\n");
      }

      entries.push("network={");
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
      essid = await exec(`iwgetid -r ${this.name}`, {encoding: "utf8"}).then(result => result.stdout.trim()).catch((err) => null);
    }
    return essid;
  }

  async state() {
    const state = await super.state();
    const vendor = await platform.getWlanVendor().catch( err => {this.log.error("Failed to get WLAN vendor:",err.message); return '';} );
    const essid = await this.getEssid();
    state.essid = essid;
    state.vendor = vendor;
    return state;
  }

  onEvent(e) {
    super.onEvent(e);
    const eventType = event.getEventType(e);
    if (eventType === event.EVENT_WPA_CONNECTED) {
      this.flushIP().then(() => this.applyIpSettings()).catch((err) => {
        this.log.error(`Failed to apply IP settings on ${this.name}`, err.message);
      });
    }
  }
}

module.exports = WLANInterfacePlugin;
