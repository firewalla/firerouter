/*    Copyright 2021 Firewalla Inc
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
const ncm = require('../../core/network_config_mgr')

const exec = require('child-process-promise').exec;
const pl = require('../plugin_loader.js');
const r = require('../../util/firerouter.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const event = require('../../core/event.js');
const util = require('../../util/util.js');

const platform = require('../../platform/PlatformLoader.js').getPlatform();

const wpaSupplicantServiceFileTemplate = `${r.getFireRouterHome()}/scripts/firerouter_wpa_supplicant@.template.service`;
const wpaSupplicantScript = `${r.getFireRouterHome()}/scripts/wpa_supplicant.sh`;

const WLAN_AVAILABLE_RETRY = 3
const WLAN_BGSCAN_INTERVAL = 20
const WLAN_INIT_SCAN_RETRY = 3

class WLANInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
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

    if (this.networkConfig.wpaSupplicant) {
      const entries = [];

      let availableWLANs
      for (let i = WLAN_AVAILABLE_RETRY; i--; i) try {
        availableWLANs = await ncm.getWlansViaWpaSupplicant()
        if (availableWLANs && availableWLANs.length)
          break; // stop on first successful call
      } catch(err) {
        this.log.warn('Error scanning WLAN, trying again after 2s ...', err.message)
        await util.delay(2)
      }
      availableWLANs = availableWLANs || []

      entries.push(`ctrl_interface=DIR=${r.getRuntimeFolder()}/wpa_supplicant/${this.name}`);
      // use high shreshold to force constant bgscan
      // simple - Periodic background scans based on signal strength
      // bgscan="simple:<short bgscan interval in seconds>:<signal strength threshold>:<long interval>"
      entries.push(`bgscan="simple:${WLAN_BGSCAN_INTERVAL}:0:${WLAN_BGSCAN_INTERVAL}"`);
      // autoscan is like bgscan but on disconnected or inactive state.
      entries.push(`autoscan=periodic:${WLAN_BGSCAN_INTERVAL}`);

      const networks = this.networkConfig.wpaSupplicant.networks || [];
      for (const network of networks) {

        const prioritizedNetworks = availableWLANs
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
          if (!network.priority) {
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

      if (this.networkConfig.enabled) {
        await exec(`sudo systemctl start firerouter_wpa_supplicant@${this.name}`).catch((err) => {
          this.log.error(`Failed to start firerouter_wpa_supplicant on $${this.name}`, err.message);
        });
        // autoscan won't start until the first manual scan
        (async () => {
          for (let i = WLAN_INIT_SCAN_RETRY; i--; i) {
            try {
              await util.delay(10)
              await exec(`sudo wpa_cli -p ${r.getRuntimeFolder()}/wpa_supplicant/${this.name} scan`)
            } catch(err) {
              this.log.warn('Failed to start initial scan, trying again soon...')
              continue
            }
            break
          }
        })()
      } else {
        await exec(`sudo systemctl stop firerouter_wpa_supplicant@${this.name}`).catch((err) => {});
      }
    }

    return true;
  }

  async state() {
    const state = await super.state();
    const essid = await exec(`iwgetid -r ${this.name}`, {encoding: "utf8"}).then(result => result.stdout.trim()).catch((err) => null);
    const vendor = await platform.getWlanVendor().catch( err => {this.log.error("Failed to get WLAN vendor:",err.message); return '';} );
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
