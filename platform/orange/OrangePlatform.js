/*    Copyright 2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
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

const fsp = require('fs').promises;
const fs = require('fs');
const Platform = require('../Platform.js');
const _ = require('lodash');
const r = require('../../util/firerouter.js');
const firestatusBaseURL = "http://127.0.0.1:9966";
const exec = require('child-process-promise').exec;
const log = require('../../util/logger.js')(__filename);
const util = require('../../util/util.js');
const sensorLoader = require('../../sensors/sensor_loader.js');
const constants = require('../../util/constants.js');
const rclient = require('../../util/redis_manager.js').getRedisClient();
const AsyncLock = require('async-lock');
const lock = new AsyncLock();
const LOCK_INTF_INDEX = "LOCK_INTF_INDEX";
const ETH0_BASE = 0xffff4;
const ETH1_BASE = 0xffffa;
const LOCK_ETHERNET_RESET = "LOCK_ETHERNET_RESET";
const WLAN0_BASE = 0x4;


LOCK_AP_STATE_AUTOMATA = "LOCK_AP_STATE_AUTOMATA";
const EVENT_WPA_AUTHENTICATING = "EVENT_WPA_AUTHENTICATING";
const EVENT_WPA_DISCONNECTED = "EVENT_WPA_DISCONNECTED";
const EVENT_WPA_CONNECTED = "EVENT_WPA_CONNECTED";
const EVENT_AP_SILENCE_TIMEOUT = "EVENT_AP_SILENCE_TIMEOUT";

const STATE_AP_SILENCE = "STATE_AP_SILENCE";
const STATE_NORMAL = "STATE_NORMAL";

const BAND_24G = "2.4g";
const BAND_5G = "5g";

const LOG_TAG_STA_AP = "[STA_AP]";

let errCounter = 0;
const maxErrCounter = 100; // do not try to set mac address again if too many errors.

const hostapdRestartTasks = {};

class OrangePlatform extends Platform {

  constructor() {
    super();
    this.apStateAutomata = {wpaSupplicantPID: null, bands: {}};
    this.apStateAutomata.bands[BAND_24G] = {
      state: STATE_NORMAL,
      silenceStartTs: null,
      silenceEndTs: null,
      attemptedSSIDs: new Set(),
    };
    this.apStateAutomata.bands[BAND_5G] = {
      state: STATE_NORMAL,
      silenceStartTs: null,
      silenceEndTs: null,
      attemptedSSIDs: new Set(),
    }
    this.apPause = {};
    this.apStateAutomataTask = setInterval(() => {
      this.checkAPStateAutomata().catch((err) => {
        log.error("Failed to check AP state automata", err.message);
      });
    }, 2000);
  }

  getName() {
    return "orange";
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/files/default_setup.json`;
  }

  async getWlanVendor() {
    return "mt7996e";
  }

  async getWpaCliBinPath() {
    return "wpa_cli";
  }

  async getWpaPassphraseBinPath() {
    return "wpa_passphrase";
  }

  async ledNormalVisibleStart() {
    await exec(`curl -s '${firestatusBaseURL}/fire?name=firerouter&type=normal_visible'`).catch( (err) => {
      log.error("Failed to set LED as WAN normal visible");
    });
  }

  async ledNormalVisibleStop() {
    await exec(`curl -s '${firestatusBaseURL}/resolve?name=firerouter&type=normal_visible'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAllNetworkDown() {
    await exec(`curl -s '${firestatusBaseURL}/fire?name=firerouter&type=network_down'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAnyNetworkUp() {
    await exec(`curl -s '${firestatusBaseURL}/resolve?name=firerouter&type=network_down'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async overrideEthernetKernelModule() {
    
  }

  async configEthernet() {
    await this.setEthernetOffload("eth1","sg","scatter-gather","on");
    await this.setEthernetOffload("eth1","tso","TCP segmentation offload","on");
    await this.setEthernetOffload("eth1","gso","generic segmentation offload","on");
  }

  async resetEthernet() {
    // unnecessary at the moment
    return;
    await lock.acquire(LOCK_ETHERNET_RESET, async () => {
      // Check if mtketh_reset file exists, check timestamp, and run reset if more than 15 minutes have passed
      const mtkethResetFile = "/dev/shm/mtketh_reset";
      const currentTime = Math.floor(Date.now() / 1000); // current time in seconds
      const coolDownSeconds = 30 * 60;

      let shouldReset = false;
      const fileExists = await fsp.access(mtkethResetFile, fs.constants.F_OK).then(() => true).catch(() => false);

      if (!fileExists) {
        shouldReset = true;
      } else {
        // Read timestamp from file
        const prevTs = await fsp.readFile(mtkethResetFile, {encoding: "utf8"}).catch(() => null);
        if (prevTs) {
          const lastResetTime = parseInt(prevTs.trim(), 10);
          if (!isNaN(lastResetTime) && (currentTime - lastResetTime) > coolDownSeconds) {
            shouldReset = true;
          }
        } else {
          // If we can't read the file, reset anyway
          shouldReset = true;
        }
      }

      if (shouldReset) {
        log.info("Resetting ethernet");
        // these commands will trigger workqueue work to reset the dma ring
        await exec(`sudo bash -c "echo 2 > /sys/kernel/debug/mtketh/reset; echo 1 > /sys/kernel/debug/mtketh/reset"`).catch((err) => {
          log.error("Failed to run mtketh reset commands", err.message);
        });
        // Record current timestamp in the file
        await fsp.writeFile(mtkethResetFile, currentTime.toString()).catch((err) => {
          log.error("Failed to write mtketh_reset file", err.message);
        });
      }
    }).catch((err) => {
      log.error("Failed to reset ethernet", err.message);
    });
  }

  getWifiClientInterface() {
    return "wlan0";
  }

  getAPScanInterface() {
    return "wlan_ap_scan";
  }

  async overrideWLANKernelModule() {
  }

  _isPhysicalInterface(iface) {
    return ["eth0", "eth1"].includes(iface) || iface.startsWith("wlan");
  }

  // get interface permanent MAC address, only applicable to ethernet interfaces and wlan interfaces
  async getNativeAddress(iface, config) {
    if(!this._isPhysicalInterface(iface)) {
      return null;
    }
    switch (iface) {
      case "eth0": {
        const hexAddr = await this._getHexBaseAddress(ETH0_BASE);
        return hexAddr.toString(16).padStart(12, "0").match(/.{1,2}/g).join(":").toUpperCase();
      }
      case "eth1": {
        const hexAddr = await this._getHexBaseAddress(ETH1_BASE);
        return hexAddr.toString(16).padStart(12, "0").match(/.{1,2}/g).join(":").toUpperCase();
      }
      default: {
        return await this._getWLANAddress(iface, config.band);
      }
    }
  }

  getModelName() {
    return "Firewalla Orange";
  }

  // must kill ifplugd before changing orange mac address
  async setHardwareAddress(iface, hwAddr) {
    if(!this._isPhysicalInterface(iface)) {
      // for non-phy ifaces, use function from base class
      await super.setHardwareAddress(iface, hwAddr);
      return;
    }

    if(errCounter >= maxErrCounter) { // should not happen in production, just a self protection
      log.error("Skip set hardware address if too many errors on setting hardware address.");
      return;
    }

    if(hwAddr) {
      const activeMac = await this.getActiveMac(iface);
      if((activeMac && activeMac.toUpperCase()) === (hwAddr && hwAddr.toUpperCase())) {
        log.info(`Skip setting hwaddr of ${iface}, as it's already been configured.`);
        return;
      }
      await this._setHardwareAddress(iface, hwAddr);
    }
  }

  async _setHardwareAddress(iface, hwAddr) {
    log.info(`Setting ${iface} hwaddr to`, hwAddr);

    const ifplug = sensorLoader.getSensor("IfPlugSensor");
    if(ifplug) {
      await ifplug.stopMonitoringInterface(iface);
    }
    await exec(`sudo ip link set ${iface} down`);
    await exec(`sudo ip link set ${iface} address ${hwAddr}`).catch((err) => {
      log.error(`Failed to set hardware address of ${iface} to ${hwAddr}`, err.message);
      errCounter++;
    });
    await exec(`sudo ip link set ${iface} up`);
    if(ifplug) {
      await ifplug.startMonitoringInterface(iface);
    }
  }

  async resetHardwareAddress(iface, config) {
    if(!this._isPhysicalInterface(iface)) {
      // for non-phy ifaces, use function from base class
      await super.resetHardwareAddress(iface, config);
      return;
    }

    const activeMac = await this.getActiveMac(iface);
    const nativeMac = await this.getNativeAddress(iface, config);
    if(!nativeMac) {
      log.error("Unable to get native mac for iface", iface);
      return;
    }

    if ((activeMac && activeMac.toUpperCase()) !== (nativeMac && nativeMac.toUpperCase())) {
      if(errCounter >= maxErrCounter) { // should not happen in production, just a self protection
        log.error(`Skip set hwaddr of ${iface} if too many errors on setting hardware address.`);
        return;
      }

      log.info(`Resetting the hwaddr of ${iface} back to factory default:`, nativeMac);
      await this._setHardwareAddress(iface, nativeMac);
    } else {
      log.info(`no need to reset hwaddr of ${iface}, it's already resetted.`);
    }
  }

  async createWLANInterface(wlanIntfPlugin) {
    const macAddr = wlanIntfPlugin.networkConfig.hwAddr || await this._getWLANAddress(wlanIntfPlugin.name, wlanIntfPlugin.networkConfig.band);
    const phyName = await this._get80211PhyName();
    if (!phyName) {
      throw new Error("Failed to get 802.11 phy name");
    }
    if (!await wlanIntfPlugin.isInterfacePresent()) {
      await exec(`sudo iw phy ${phyName} interface add ${wlanIntfPlugin.name} type ${await this._getWLANInterfaceType(wlanIntfPlugin)}`);
    }
    await exec(`sudo ip link set ${wlanIntfPlugin.name} down`).catch((err) => {});
    await exec(`sudo ip link set ${wlanIntfPlugin.name} address ${macAddr}`).catch((err) => {});
  }

  async removeWLANInterface(wlanIntfPlugin) {
    await exec(`sudo iw dev ${wlanIntfPlugin.name} del`).catch((err) => {});
  }

  async _getWLANInterfaceType(wlanIntfPlugin) {
    if (wlanIntfPlugin.networkConfig.type)
      return wlanIntfPlugin.networkConfig.type;
    if (wlanIntfPlugin.name === this.getWifiClientInterface() || wlanIntfPlugin.name === this.getAPScanInterface())
      return "managed";
    return "__ap";
  }

  async _get80211PhyName() {
    const phyNames = await fsp.readdir(`/sys/class/ieee80211/`);
    if (!_.isEmpty(phyNames))
      return phyNames[0];
    return null;
  }

  async _getWLANAddress(intfName, band) {
    // base is for wlan0, 2.4g uses base + 1, 5g uses base + 2s
    if (intfName === this.getWifiClientInterface() || intfName === this.getAPScanInterface()) {
      let addr = await this._getHexBaseAddress(WLAN0_BASE);
      if (intfName === this.getAPScanInterface()) {
        addr += 0x060000000000;
      }
      return addr.toString(16).padStart(12, "0").match(/.{1,2}/g).join(":").toUpperCase();
    } else {
      let offset = 0;
      if (band === "2.4g" || band == "2g") {
        offset = 1;
      } else if (band === "5g") {
        offset = 2;
      }
      let addr = await this._getHexOffsetAddress(WLAN0_BASE, offset);
      const idx = await this._allocateIntfIndex(intfName, band);
      if (idx > 0)
        addr += 0x040000000000 * idx + 0x020000000000;
      return addr.toString(16).padStart(12, "0").match(/.{1,2}/g).join(":").toUpperCase();
    }
  }

  async _getHexOffsetAddress(base, offset) {
    const addr = await this._getHexBaseAddress(base);
    return addr + offset;
  }

  async _getHexBaseAddress(base) {
    let baseAddress = await rclient.getAsync(`base_mac_address:${base}`);
    if (!baseAddress) {
      baseAddress = await exec(`sudo xxd -u -p -l 6 -s ${base} /dev/mtdblock2`).then(result => result.stdout.trim().padStart(12, "0").match(/.{1,2}/g).join(":")).catch(() => {
        return null;
      });
      if (!baseAddress || !baseAddress.startsWith("20:6D:31")) {
        log.info(`Base address is invalid: ${baseAddress}, will generate a random base address.`);
        baseAddress = util.generateRandomMacAddress("20:6D:31");
      }
      await rclient.setAsync(`base_mac_address:${base}`, baseAddress);
    }
    return parseInt(baseAddress.split(":").join(""), 16);
  }

  // this function needs to be run sequentially
  async _allocateIntfIndex(intfName, band = "5g") {
    if (band == "2g")
      band = "2.4g";
    return await lock.acquire(LOCK_INTF_INDEX, async () => {
      let idx = await rclient.hgetAsync(`intf_index_hash:${band}`, intfName);
      if (idx) {
        const name = await rclient.hgetAsync(`index_intf_hash:${band}`, idx);
        if (name === intfName) {
          return idx;
        }
      }
      const pl = require('../../plugins/plugin_loader.js');
      for (let i = 0; i < 32; i++) {
        const name = await rclient.hgetAsync(`index_intf_hash:${band}`, i);
        if (!name || !pl.getPluginInstance("interface", name)) {
          await rclient.hsetAsync(`intf_index_hash:${band}`, intfName, i);
          await rclient.hsetAsync(`index_intf_hash:${band}`, i, intfName);
          return i;
        }
      }
      throw new Error("Failed to allocate interface index for " + intfName);
    });
  }

  isWLANManagedByAPC() {
    return true;
  }

  isHotplugSupported(intf) {
    const fixedIntfs = ["eth0", "eth1"];
    // all wlan interfaces are created by firerouter on orange, so they are not hotplug supported
    return !fixedIntfs.includes(intf) && !intf.startsWith("wlan");
  }

  isPDOSupported() {
    return true;
  }

  async loadPDOInfo() {
    const pdoInfoFile = `/dev/shm/pdo_info`;
    let pdoInfo = null;
    const fileExists = await fsp.access(pdoInfoFile, fs.constants.F_OK).then(() => true).catch(() => false);
    if (!fileExists) {
      const output = await exec(`sudo ${this.getFilesPath()}/get_pdo.sh`).then(result => result.stdout).catch(() => null);
      if (!output) {
        log.error("Failed to get PDO info from script");
        return {};
      }
      await fsp.writeFile(pdoInfoFile, output);
      pdoInfo = output;
    } else {
      pdoInfo = await fsp.readFile(pdoInfoFile, {encoding: "utf8"}).catch(() => null);
    }
    if (!pdoInfo) {
      log.error("Failed to get PDO info from file");
      return {};
    }
    const lines = pdoInfo.split("\n");
    const result = {};
    for (const line of lines) {
      const [key, value] = line.split("=");
      result[key] = value;
    }
    /* sample pdo info
    PDO_IDX=0
    VOLTAGE=11400
    CURRENT=150
    POWER_TYPE=Fixed
    */
    return result;
  }

  getEffectivePowerMode(pdoInfo, configuredPowerMode) {
    // limit to power save mode if PDO is not supported or maximum power is less than or equal to 15W
    if (!_.isObject(pdoInfo))
      return constants.POWER_MODE_POWERSAVE;
    if (!_.has(pdoInfo, 'PDO_IDX') || pdoInfo.PDO_IDX == 0)
      return constants.POWER_MODE_POWERSAVE;
    const voltage = pdoInfo.VOLTAGE;
    const current = pdoInfo.CURRENT;
    if (isNaN(voltage) || isNaN(current))
      return constants.POWER_MODE_POWERSAVE;
    if (Number(voltage) / 1000 * Number(current) / 1000 <= 15)
      return constants.POWER_MODE_POWERSAVE;
    // reach here if PDO is supported and maximum power is greater than 15W, if configured power mode is ondemand, use performance mode by default
    if ((configuredPowerMode || constants.POWER_MODE_ONDEMAND) === constants.POWER_MODE_ONDEMAND)
      return constants.POWER_MODE_PERFORMANCE;
    // otherwise use configured power mode
    return configuredPowerMode || constants.POWER_MODE_PERFORMANCE;
  }

  getWpaSupplicantGlobalDefaultConfig() {
    return {};
  }

  getWpaSupplicantNetworkDefaultConfig() {
    return {};
  }

  async _mergeHostapdConfig(band) {
    const files = await fsp.readdir(`${r.getUserConfigFolder()}/hostapd/band_${band}`).catch((err) => []);
    const bssConfigs = [];
    const interfaceConfigs = [];
    for (const file of files) {
      if (!file.endsWith(`.conf`)) {
        continue;
      }
      const intf = file.replace(".conf", "");
      const parameters = await fsp.readFile(`${r.getUserConfigFolder()}/hostapd/band_${band}/${file}`, {encoding: 'utf8'}).then(content => content.split("\n").reduce((result, line) => {
        const sepIdx = line.indexOf("=");
        if (sepIdx !== -1) {
          result[line.slice(0, sepIdx)] = line.slice(sepIdx + 1);
        }
        return result;
      }, {})).catch(() => ({}));
      delete parameters.interface;
      let isPrimary = false;
      if (parameters.primary) {
        isPrimary = true;
        delete parameters.primary;
      }
      const configs = isPrimary ? interfaceConfigs : bssConfigs;
      if (isPrimary) {
        configs.push(`interface=${intf}`);
      } else {
        configs.push(`bss=${intf}`);
        configs.push(`bssid=${await this._getWLANAddress(intf, band)}`);
      }
      for (const key of Object.keys(parameters)) {
        configs.push(`${key}=${parameters[key]}`);
      }
      configs.push("");
    }
    return interfaceConfigs.concat(bssConfigs);
  }

  async enableHostapd(iface, parameters) {
    const band = parameters.hw_mode === "g" ? BAND_24G : BAND_5G;
    await fsp.writeFile(`${r.getUserConfigFolder()}/hostapd/band_${band}/${iface}.conf`, Object.keys(parameters).map(k => `${k}=${parameters[k]}`).join("\n"), {encoding: 'utf8'});
    this.scheduleHostapdRestart(band);
  }

  async disableHostapd(iface) {
    // this is just for backward compatibility, we don't need to stop firerouter_hostapd@${iface} in future releases
    await exec(`sudo systemctl stop firerouter_hostapd@${iface}`).catch((err) => {});
    for (const band of [BAND_24G, BAND_5G]) {
      const files = await fsp.readdir(`${r.getUserConfigFolder()}/hostapd/band_${band}`).catch((err) => []);
      if (files.includes(`${iface}.conf`)) {
        await fsp.unlink(`${r.getUserConfigFolder()}/hostapd/band_${band}/${iface}.conf`).catch((err) => {});
        this.scheduleHostapdRestart(band);
        break;
      }
    }
  }

  scheduleHostapdRestart(band) {
    // use a timer to avoid restarting hostapd too frequently
    if (hostapdRestartTasks[band]) {
      clearTimeout(hostapdRestartTasks[band]);
    }
    hostapdRestartTasks[band] = setTimeout(async () => {
      const bssConfigs = await this._mergeHostapdConfig(band);
      if (_.isEmpty(bssConfigs)) {
        await fsp.unlink(`${r.getUserConfigFolder()}/hostapd/band_${band}.conf`).catch((err) => {});
        log.info(`Removed hostapd config on band ${band}, stopping hostapd service`);
        await exec(`sudo systemctl stop firerouter_hostapd@band_${band}`).catch((err) => {});
      } else {
        await fsp.writeFile(`${r.getUserConfigFolder()}/hostapd/band_${band}.conf`, bssConfigs.join("\n"), {encoding: 'utf8'});
        if (this.apPause[band]) {
          log.info(`AP on band ${band} is paused, stop it`);
          await exec(`sudo systemctl stop firerouter_hostapd@band_${band}`).catch((err) => {});
          return;
        } else {
          log.info(`Updated hostapd config on band ${band}, restarting hostapd service`);
          await exec(`sudo systemctl restart firerouter_hostapd@band_${band}`).catch((err) => {});
        }
      }
    }, 2000);
  }

  pauseAP(band) {
    this.apPause[band] = true;
    this.scheduleHostapdRestart(band);
  }

  resumeAP(band) {
    delete this.apPause[band];
    this.scheduleHostapdRestart(band);
  }

  async processWpaSupplicantLog(line, config) {
    // Nov  5 14:57:37 localhost wpa_supplicant[1562300]: wlan0: SME: Trying to authenticate with 20:6d:31:fa:2a:91 (SSID='xxxxxxx' freq=5765 MHz)
    if (line.includes('SME: Trying to authenticate with')) {
      const match = line.match(/wpa_supplicant(\[[0-9]+\]): wlan0: SME: Trying to authenticate with ([0-9a-f:]+) \(SSID='([^']+)' freq=([0-9]+) MHz\)/);
      if (match) {
        const pid = match[1];
        const bssid = match[2];
        const ssid = match[3];
        const freq = Number(match[4]);
        this.onEvent(EVENT_WPA_AUTHENTICATING, {pid, ssid, freq, bssid});
      }
      return;
    }
    // Nov  5 00:38:47 localhost wpa_supplicant[3326147]: wlan0: CTRL-EVENT-CONNECTED - Connection to 20:6d:31:61:01:99 completed [id=0 id_str=]
    if (line.includes('CTRL-EVENT-CONNECTED - Connection to')) {
      const match = line.match(/wpa_supplicant(\[[0-9]+\]): wlan0: CTRL-EVENT-CONNECTED - Connection to ([0-9a-f:]+) completed \[id=([0-9]+) id_str=\]/);
      if (match) {
        const pid = match[1];
        const bssid = match[2];
        const id = match[3];
        this.onEvent(EVENT_WPA_CONNECTED, {pid, bssid, id});
      }
      return;
    }

    // Nov 11 09:00:06 localhost wpa_supplicant[1235280]: wlan0: CTRL-EVENT-SCAN-FAILED ret=-16 retry=1
    if (line.includes('CTRL-EVENT-SCAN-FAILED ret=-16')) {
      await this.setDFSScanState(true);
      await this.skipDFSCAC();
      return;
    }
  }

  async onEvent(event, data) {
    await lock.acquire(LOCK_AP_STATE_AUTOMATA, async () => {
      switch (event) {
        case EVENT_WPA_AUTHENTICATING: {
          // wpa supplicant pid is changed, maybe config is updated
          const {pid, bssid, ssid, freq} = data;
          const channel = util.freqToChannel(freq);
          if (!channel) {
            log.error(`${LOG_TAG_STA_AP} Failed to convert frequency ${freq} to channel`);
            return;
          }
          const band = freq >= 5000 ? BAND_5G : BAND_24G;
          if (pid !== this.apStateAutomata.wpaSupplicantPID) {
            log.info(`${LOG_TAG_STA_AP} wpa_supplicant pid changed, clearing attempted SSIDs cache`);
            this.apStateAutomata.bands[BAND_24G].attemptedSSIDs.clear();
            this.apStateAutomata.bands[BAND_5G].attemptedSSIDs.clear();
          }
          this.apStateAutomata.wpaSupplicantPID = pid;
          const stateAutomata = this.apStateAutomata.bands[band];
          switch (stateAutomata.state) {
            case STATE_AP_SILENCE: {
              if (!stateAutomata.attemptedSSIDs.has(`${ssid}`)) {
                // extend silence period by 30 seconds for each new SSID authentication attempt
                log.info(`${LOG_TAG_STA_AP} Extending silence period on band ${band} by 45 seconds for SSID ${ssid} authentication attempt`);
                stateAutomata.silenceEndTs = Date.now() + 45000;
              }
              stateAutomata.attemptedSSIDs.add(`${ssid}`);
              break;
            }
            case STATE_NORMAL: {
              const pl = require('../../plugins/plugin_loader.js');
              const hostapds = pl.getPluginInstances("hostapd");
              if (_.isEmpty(hostapds)) {
                return;
              }
              if (stateAutomata.attemptedSSIDs.has(`${ssid}`)) {
                log.info(`${LOG_TAG_STA_AP} SSID ${ssid} has been attempted on band ${band} before, skip it to avoid consecutive failed attempts`);
                return;
              }
              log.info(`${LOG_TAG_STA_AP} New authentication attempt for SSID ${ssid} on band ${band} with channel ${channel}, checking if AP is configured on the same channel`);
              for (const key of Object.keys(hostapds)) {
                const hostapd = hostapds[key];
                const parameters = _.get(hostapd, 'networkConfig.params', {});
                if (parameters.channel === channel) {
                  log.info(`${LOG_TAG_STA_AP} AP band ${band} is already configured on channel ${channel}, same as SSID ${ssid}`);
                  return;
                }
              }
              log.info(`${LOG_TAG_STA_AP} AP band ${band} is not configured on the same channel ${channel} as SSID ${ssid}, entering silence period`);
              stateAutomata.state = STATE_AP_SILENCE;
              stateAutomata.silenceStartTs = Date.now();
              stateAutomata.silenceEndTs = Date.now() + 45000;
              this.pauseAP(band);
              break;
            }
          }
          break;
        }
        case EVENT_WPA_CONNECTED: {
          const {pid, bssid} = data;
          log.info(`${LOG_TAG_STA_AP} WPA connection established, clearing attempted SSIDs cache`);
          this.apStateAutomata.bands[BAND_24G].attemptedSSIDs.clear();
          this.apStateAutomata.bands[BAND_5G].attemptedSSIDs.clear();
          this.apStateAutomata.wpaSupplicantPID = pid;

          for (const band of [BAND_24G, BAND_5G]) {
            const stateAutomata = this.apStateAutomata.bands[band];
            if (stateAutomata.state === STATE_AP_SILENCE) {
              log.info(`${LOG_TAG_STA_AP} WPA connection established, silence period on band ${band} will end in 5 seconds`);
              stateAutomata.silenceEndTs = Date.now() + 5000;
            }
          }
          break;
        }
      }
    }).catch((err) => {
      log.error(`${LOG_TAG_STA_AP} Failed to process AP state automata event`, err.message);
    });
  }

  async checkAPStateAutomata() {
    await lock.acquire(LOCK_AP_STATE_AUTOMATA, async () => {
      const ncm = require('../../core/network_config_mgr.js');
      for (const band of [BAND_24G, BAND_5G]) {
        const stateAutomata = this.apStateAutomata.bands[band];
        if (stateAutomata.state === STATE_AP_SILENCE) {
          if (Date.now() >= stateAutomata.silenceEndTs) {
            stateAutomata.state = STATE_NORMAL;
            let needReapplyConfig = true;
            const pl = require('../../plugins/plugin_loader.js');
            const wlanIntf = pl.getPluginInstance("interface", this.getWifiClientInterface());
            if (!wlanIntf) {
              this.resumeAP(band);
              continue;
            }
            const hostapds = pl.getPluginInstances("hostapd");
            if (_.isEmpty(hostapds)) {
              this.resumeAP(band);
              continue;
            }
            const {freq} = await wlanIntf.getWpaStatus();
            const channel = freq && util.freqToChannel(freq) || null;
            const staBand = channel && (channel >= 1 && channel <= 14 ? BAND_24G : BAND_5G) || null;
            if (!channel || staBand !== band) {
              // restore original config on AP interfaces, so need to reapply current config
              log.info(`${LOG_TAG_STA_AP} Silence period on band ${band} ended, sta is not connected on this band, need to reapply current config and resume AP`);
              needReapplyConfig = true;
            } else {
              for (const key of Object.keys(hostapds)) {
                const hostapd = hostapds[key];
                const parameters = _.get(hostapd, 'networkConfig.params', {});
                const hostapd_band = parameters.hw_mode === "g" ? BAND_24G : BAND_5G;
                if (hostapd_band !== band) {
                  continue;
                } else {
                  if (parameters.channel === channel) {
                    log.info(`${LOG_TAG_STA_AP} Silence period on band ${band} ended, AP configured channel is same as STA's channel ${channel}, resumeing AP`);
                    needReapplyConfig = false;
                  } else {
                    log.info(`${LOG_TAG_STA_AP} Silence period on band ${band} ended, AP configured channel ${parameters.channel} is not same as STA's channel ${channel}, need to reapply current config and resume AP`);
                    needReapplyConfig = true;
                  }
                  break;
                }
              }
            }
            if (needReapplyConfig) {
              await ncm.acquireConfigRWLock(async () => {
                const currentConfig = await ncm.getActiveConfig();
                if (currentConfig) {
                  await ncm.tryApplyConfig(currentConfig).catch((err) => {
                    log.error(`${LOG_TAG_STA_AP} Failed to reapply current config`, err.message);
                  });
                }
              });
            }
            this.resumeAP(band);
          }
        }
      }
    }).catch((err) => {
      log.error(`${LOG_TAG_STA_AP} Failed to check AP state automata`, err.message);
    });
  }
  
  needResetLinkBeforeSwitchWifi() {
    return false;
  }

  async setDFSScanState(state) {
    const phyName = await this._get80211PhyName();
    if (!phyName) {
      return;
    }
    const value = state ? 1 : 0;
    log.info(`Set DFS scan state to ${value} on phy ${phyName}`);
    await exec(`echo ${value} | sudo tee /sys/kernel/debug/ieee80211/${phyName}/scan_dfs_relax`).catch((err) => {
      log.error(`Failed to set DFS scan state to ${value} on phy ${phyName}`, err.message);
    });
  }

  async skipDFSCAC() {
    const phyName = await this._get80211PhyName();
    if (!phyName) {
      return;
    }
    log.info(`Skip DFS CAC on phy ${phyName}`);
    await exec(`echo 1 | sudo tee /sys/kernel/debug/ieee80211/${phyName}/dfs_skip_cac`).catch((err) => {
      log.error(`Failed to skip DFS CAC on phy ${phyName}`, err.message);
    });
  }

  async prepareSwitchWifi() {
    await this.setDFSScanState(true);
    await this.skipDFSCAC();
    for (const band of [BAND_24G, BAND_5G]) {
      this.apStateAutomata.bands[band].attemptedSSIDs.clear();
    }
  }

  getWpaSupplicantDefaultConfig() {
    return [
      "scan_res_valid_for_connect=10",
      "bss_max_count=400"
    ];
  }

  getWpaCliScanResultCommand() {
    return 'all_bss';
  }

  isWDSSupported() {
    return true;
  }

  async setWifiDynamicDebug() {
    await exec(`echo -n 'module mac80211 -p' | sudo tee /sys/kernel/debug/dynamic_debug/control`).catch((err) => { });
  }
}

module.exports = OrangePlatform;
