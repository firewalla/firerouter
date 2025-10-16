/*    Copyright 2021-2024 Firewalla Inc.
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
const rclientDB0 = require('../../util/redis_manager.js').getPrimaryDBRedisClient()

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
  pmf: 1,
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

  getDefaultMTU() {
    return 1500;
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

  async apply() {
    if (platform.wifiSD && await this.isInterfacePresent() && !await r.verifyPermanentMAC(this.name)) {
      this.log.error(`Permanent MAC address of ${this.name} is not valid, ignore it`);
      return;
    }
    await super.apply();
  }

  async flush() {
    await super.flush();

    await platform.removeWLANInterface(this);

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
    try {
      await platform.createWLANInterface(this);
    } catch (err) {
      this.log.error(`Failed to create wlan interface ${this.name}`, err.message);
      return false;
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
    const wpaStatus = await this.getWpaStatus();
    return wpaStatus.ssid;
  }

  async getWpaStatus() {
    // wpa_cli is interoperable on both station and ap interface
    const lines = await exec(`sudo ${await platform.getWpaCliBinPath()} -p ${this.isWAN() ? `${r.getRuntimeFolder()}/wpa_supplicant/${this.name}` : `${r.getRuntimeFolder()}/hostapd`} -i ${this.name} status`)
      .then(result => result.stdout.trim().split('\n')).catch(() => []);
    const status = {};
    /*
      for station interface:
      bssid=20:6d:31:61:01:98
      freq=2437
      ssid=TEST
      id=0
      mode=station
      wifi_generation=4
      pairwise_cipher=CCMP
      group_cipher=CCMP
      key_mgmt=WPA2-PSK
      wpa_state=COMPLETED
      ip_address=192.168.242.60
      address=20:6d:31:fa:2a:90
      uuid=23c32869-798e-53d8-bfc2-7d611cfc0e47
      ieee80211ac=1

      for ap interface:
      state=ENABLED
      phy=phy0
      freq=5180
      num_sta_non_erp=0
      num_sta_no_short_slot_time=0
      num_sta_no_short_preamble=0
      olbc=0
      num_sta_ht_no_gf=0
      num_sta_no_ht=0
      num_sta_ht_20_mhz=0
      num_sta_ht40_intolerant=0
      olbc_ht=1
      ht_op_mode=0x11
      hw_mode=a
      country_code=US
      country3=0x20
      cac_time_seconds=60
      cac_time_left_seconds=N/A
      channel=36
      edmg_enable=0
      edmg_channel=0
      secondary_channel=1
      ieee80211n=1
      ieee80211ac=1
      ieee80211ax=1
      ieee80211be=1
      beacon_int=100
      dtim_period=2
      eht_oper_chwidth=2
      eht_oper_centr_freq_seg0_idx=50
      he_oper_chwidth=2
      he_oper_centr_freq_seg0_idx=50
      he_oper_centr_freq_seg1_idx=0
      vht_oper_chwidth=2
      vht_oper_centr_freq_seg0_idx=50
      vht_oper_centr_freq_seg1_idx=0
      vht_caps_info=338979f6
      rx_vht_mcs_map=fffa
      tx_vht_mcs_map=fffa
      ht_caps_info=09ef
      ht_mcs_bitmask=ffff0000000000000000
      supported_rates=0c 12 18 24 30 48 60 6c
      max_txpower=23
      bss[0]=wlan5g_6f5b51
      bssid[0]=20:6d:31:80:00:22
      ssid[0]=o6-5g
      num_sta[0]=0
      bss[1]=wlan5g_c5144d
      bssid[1]=26:6d:31:80:00:22
      ssid[1]=o6-5g-2
      num_sta[1]=0
    */
    let bssIndex = 0;
    for (const line of lines) {
      const sepIndex = line.indexOf('=');
      if (sepIndex === -1) continue;
      const key = line.substring(0, sepIndex);
      const value = line.substring(sepIndex + 1);
      switch (key) {
        case "freq":
          status.freq = Number(value);
          break;
        default:
          status[key] = value;
      }
      if (key.startsWith('bss[')) {
        bssIndex = Number(key.substring(4, key.indexOf(']')));
      }
    }
    if (!this.isWAN())
      status.ssid = status[`ssid[${bssIndex}]`];
    return status;
  }

  async state() {
    const state = await super.state();
    const vendor = await platform.getWlanVendor().catch( err => {this.log.error("Failed to get WLAN vendor:",err.message); return '';} );
    const wpaStatus = await this.getWpaStatus();
    const essid = wpaStatus.ssid;
    state.essid = essid;
    state.carrier = (this.isWAN()
      ? await this.readyToConnect().catch(() => false)
      : state.essid && state.carrier
    ) ? 1 : 0
    if (state.carrier && state.essid) {
      state.freq = wpaStatus.freq
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

  async setHardwareAddress() {
    await super.setHardwareAddress()

    if (platform.wifiSD) try {
      const mac = await this._getSysFSClassNetValue("address")
      await rclientDB0.saddAsync('sys:wifiSD:addresses', mac)
    } catch(err) {
      this.log.error('Failed to log wifiSD mac', err)
    }
  }
}

module.exports = WLANInterfacePlugin;
