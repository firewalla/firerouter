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
const crypto = require('crypto');
const Platform = require('../Platform.js');
const _ = require('lodash');
const r = require('../../util/firerouter.js');
const firestatusBaseURL = "http://127.0.0.1:9966";
const { exec, execFile } = require('child-process-promise');
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
const FIRMWARE_PATCH_RELOAD = `${r.getRuntimeFolder()}/firmware_patch_reload`;
const FIRMWARE_PATCH_COPY = `/dev/shm/firmware_patch_copy`;
const FIRMWARE_PATCH_SAFE = `${r.getRuntimeFolder()}/firmware_patch_safe`;


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
    // bands whose AP interfaces were deleted or recreated since hostapd last started
    this.apIntfReset = {};
    // per band, while a config sync runs: the channel the running AP is already on, as its config only catches up with it
    this.hostapdSyncKeep = {};
    // per band, the channel the pending restart may keep the AP on, taken from the sync that scheduled it, if any
    this.hostapdKeepRunning = {};
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

  getMiniupnpdNftPath() {
    return `${this.getBinaryPath()}/u22/miniupnpd.nft`;
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
    await execFile("curl", ["-s", `${firestatusBaseURL}/fire?name=firerouter&type=normal_visible`]).catch( (err) => {
      log.error("Failed to set LED as WAN normal visible");
    });
  }

  async ledNormalVisibleStop() {
    await execFile("curl", ["-s", `${firestatusBaseURL}/resolve?name=firerouter&type=normal_visible`]).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAllNetworkDown() {
    await execFile("curl", ["-s", `${firestatusBaseURL}/fire?name=firerouter&type=network_down`]).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAnyNetworkUp() {
    await execFile("curl", ["-s", `${firestatusBaseURL}/resolve?name=firerouter&type=network_down`]).catch( (err) => {
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

  async _isWorldVersion() {
    try {
      const { stdout } = await execFile("sudo", ["xxd", "-u", "-p", "-l", "1", "-s", "0x20", "/dev/mtdblock2"]);
      return stdout.trim() === '77';
    } catch (err) {
      log.error(`Failed to check world version:`, err);
      return false;
    }
  }

  // Verifies src sha256, copies src→dst if different, verifies dst after copy, and on
  // failure restores from file.restore (or removes dst if file.restore is '').
  // Returns true if at least one file was changed and all integrity checks passed.
  async _copyFilesWithIntegrity(fileList) {
    for (const file of fileList) {
      try {
        const expectedHash = (await fsp.readFile(`${file.src}.sha256`, 'utf8')).trim();
        const { stdout } = await execFile("sha256sum", [file.src]);
        const actualHash = stdout.split(/\s+/)[0];
        if (actualHash !== expectedHash) {
          log.error(`Source file ${file.src} failed integrity check`);
          return false;
        }
      } catch (err) {
        log.error(`Failed to verify source file ${file.src}:`, err);
        return false;
      }
    }
    const copiedFiles = [];
    for (const file of fileList) {
      try {
        await execFile("cmp", ["-s", file.src, file.dst]);
      } catch (err) {
        try {
          await execFile("sudo", ["cp", "-f", file.src, file.dst]);
          log.info(`Copied ${file.src} to ${file.dst}`);
          copiedFiles.push(file);
        } catch (copyErr) {
          log.error(`Failed to copy ${file.src}:`, copyErr);
          return false;
        }
      }
    }
    if (copiedFiles.length === 0) return false;
    let integrityOk = true;
    for (const file of copiedFiles) {
      try {
        const { stdout } = await execFile("sha256sum", [file.src, file.dst]);
        const hashes = stdout.trim().split('\n').map(l => l.split(/\s+/)[0]);
        if (hashes[0] !== hashes[1]) {
          log.error(`Integrity check failed for ${file.dst}`);
          integrityOk = false;
          break;
        }
      } catch (err) {
        log.error(`Failed to verify integrity of ${file.dst}:`, err);
        integrityOk = false;
        break;
      }
    }
    if (!integrityOk) {
      for (const file of copiedFiles) {
        if (file.restore) {
          await execFile("sudo", ["cp", "-f", file.restore, file.dst]).catch(err =>
            log.error(`Failed to restore ${file.dst}:`, err)
          );
        } else {
          await execFile("sudo", ["rm", "-f", file.dst]).catch(err =>
            log.error(`Failed to remove ${file.dst}:`, err)
          );
        }
      }
      return false;
    }
    return copiedFiles;
  }

  async _updateWifiKernelModule(includeCfg80211 = false) {
    const firerouter = r.getFireRouterHome();
    const kernelVersion = '6.6.104';
    const fileList = [
      {
        src: `${firerouter}/platform/orange/files/kernel_modules/${kernelVersion}/mt76.ko`,
        dst: `/lib/modules/${kernelVersion}/kernel/drivers/net/wireless/mediatek/mt76/mt76.ko`,
        restore: `/media/root-ro/lib/modules/${kernelVersion}/kernel/drivers/net/wireless/mediatek/mt76/mt76.ko`
      },
      {
        src: `${firerouter}/platform/orange/files/kernel_modules/${kernelVersion}/mt7996e_world.ko`,
        dst: `/lib/modules/${kernelVersion}/kernel/drivers/net/wireless/mediatek/mt76/mt7996/mt7996e.ko`,
        restore: `/media/root-ro/lib/modules/${kernelVersion}/kernel/drivers/net/wireless/mediatek/mt76/mt7996/mt7996e.ko`
      },
      {
        src: `${firerouter}/platform/orange/files/mt7987a-firewalla-powerlimit.dtbo`,
        dst: `/lib/firmware/mt7987a-firewalla-powerlimit.dtbo`,
        restore: ''
      }
    ];
    if (includeCfg80211) {
      fileList.push({
        src: `${firerouter}/platform/orange/files/kernel_modules/${kernelVersion}/cfg80211.ko`,
        dst: `/lib/modules/${kernelVersion}/kernel/net/wireless/cfg80211.ko`,
        restore: `/media/root-ro/lib/modules/${kernelVersion}/kernel/net/wireless/cfg80211.ko`
      });
    }
    try {
      const copied = await this._copyFilesWithIntegrity(fileList);
      if (!copied) return [];
      await execFile("sudo", ["depmod", "-a"]);
      return copied.map(f => f.dst.split('/').pop());
    } catch (err) {
      log.error(`Failed to update WiFi kernel module for world version:`, err);
      return [];
    }
  }

  async _setNapiPhyCpuAffinity() {
    try {
      const { stdout } = await exec(`ps -axo pid,comm | grep 'napi/phy'`);
      const procs = stdout.trim().split('\n')
        .map(line => {
          const m = line.trim().match(/^(\d+)\s+napi\/phy.*-(\d+)$/);
          return m ? { pid: m[1], suffix: parseInt(m[2]) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.suffix - a.suffix);
      if (procs.length >= 2) {
        log.info(`Assigning CPU 3 to napi/phy process ${procs[0].pid}`);
        await execFile("sudo", ["taskset", "-acp", "3", procs[0].pid]);
        log.info(`Assigning CPU 0 to napi/phy process ${procs[1].pid}`);
        await execFile("sudo", ["taskset", "-acp", "0", procs[1].pid]);
      }
    } catch (err) {
      log.error(`Failed to set CPU affinity for napi/phy processes:`, err);
    }
  }

  async _reloadWifiKernelModule() {
    await exec(`sudo rmmod mt7996e; sudo modprobe mt7996e`);
    await this._setNapiPhyCpuAffinity();
  }

  async _reloadMt76KernelModule() {
    await exec(`sudo rmmod mt7996e; sudo rmmod mt76_connac_lib; sudo rmmod mt76; sudo modprobe mt76`);
  }

  async _reloadCfg80211KernelModule() {
    for (const mod of ['mt7996e', 'mt76_connac_lib', 'mt76', 'mac80211', 'cfg80211']) {
      await this.rmmodKernelModule(mod);
    }
    // modprobe mt7996e resolves and reloads cfg80211, mac80211, mt76_connac_lib, mt76 automatically
    await this.modprobeKernelModule('mt7996e');
    await this._setNapiPhyCpuAffinity();
  }

  // Only applicable to non-world version boxes with a non-US country selected: swaps in the
  // world-flavor cfg80211/mt76/mt7996e/DTBO to unlock the regulatory domain, then reloads the
  // WLAN kernel module chain. Returns true if the kernel modules were actually reloaded.
  async prepareWLANRegDomainChange(country) {
    if (!country || country === 'US') {
      return false;
    }
    if (await this._isWorldVersion()) {
      return false;
    }
    try {
      const updatedKos = await this._updateWifiKernelModule(true);
      if (!updatedKos.length) {
        return false;
      }
      log.info(`WLAN kernel modules updated for country ${country}, will reload cfg80211 kernel modules`);
      await this._reloadCfg80211KernelModule();
      return true;
    } catch (err) {
      log.error(`Failed to prepare WLAN regulatory domain change for country ${country}:`, err);
      return false;
    }
  }

  async overrideWLANKernelModule() {
    let updatedKos = [];
    if (await this._isWorldVersion()) {
      updatedKos = await this._updateWifiKernelModule();
    }
    // mt76 is the core module; reload it before _reloadWLANFirmware (which reloads mt7996e).
    if (updatedKos.includes('mt76.ko')) {
      await this._reloadMt76KernelModule();
    }
    const koReloaded = await this._reloadWLANFirmware();
    if ((updatedKos.includes('mt76.ko') || updatedKos.includes('mt7996e.ko')) && !koReloaded) {
      await this._reloadWifiKernelModule();
    }
  }

  async _isPatchSafe(patchUid) {
    const exists = p => fsp.access(p, fs.constants.F_OK).then(() => true).catch(() => false);
    const reloadFlagPath = `${FIRMWARE_PATCH_RELOAD}.${patchUid}`;
    if (!await exists(reloadFlagPath)) return true;
    const copyFlagPath = `${FIRMWARE_PATCH_COPY}.${patchUid}`;
    const safeFlagPath = `${FIRMWARE_PATCH_SAFE}.${patchUid}`;
    return (await exists(copyFlagPath)) || (await exists(safeFlagPath));
  }

  async _reloadWLANFirmware() {
    const srcDir = `${r.getFireRouterHome()}/platform/orange/files/firmware`;
    const dstDir = `/lib/firmware/mediatek/mt7996`;
    const restoreDir = `/media/root-ro/lib/firmware/mediatek/mt7996`;
    try {
      const binFiles = (await fsp.readdir(srcDir)).filter(f => f.endsWith('.bin')).sort();

      // read sha256 files to compute patchUid before copying
      const expectedHashes = {};
      for (const file of binFiles) {
        expectedHashes[file] = (await fsp.readFile(`${srcDir}/${file}.sha256`, 'utf8')).trim();
      }
      const patchUid = crypto.createHash('sha256')
        .update(binFiles.map(f => expectedHashes[f]).join(''))
        .digest('hex').slice(0, 16);

      if (!await this._isPatchSafe(patchUid)) {
        log.error(`Firmware patch ${patchUid} was previously attempted but did not survive, skipping`);
        return false;
      }

      await fsp.writeFile(`${FIRMWARE_PATCH_COPY}.${patchUid}`, '');

      const fileList = binFiles.map(file => ({
        src: `${srcDir}/${file}`,
        dst: `${dstDir}/${file}`,
        restore: `${restoreDir}/${file}`
      }));
      if (!await this._copyFilesWithIntegrity(fileList)) return false;

      await fsp.writeFile(`${FIRMWARE_PATCH_RELOAD}.${patchUid}`, '');
      await execFile("sync", []);
      await this._reloadWifiKernelModule();
      setTimeout(() => {
        fsp.writeFile(`${FIRMWARE_PATCH_SAFE}.${patchUid}`, '').catch(err =>
          log.error(`Failed to create firmware patch safe flag:`, err)
        );
      }, 10000);
      return true;
    } catch (err) {
      log.error(`Failed to override WLAN firmware:`, err);
      return false;
    }
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
    await execFile("sudo", ["ip", "link", "set", iface, "down"]);
    await execFile("sudo", ["ip", "link", "set", iface, "address", hwAddr]).catch((err) => {
      log.error(`Failed to set hardware address of ${iface} to ${hwAddr}`, err.message);
      errCounter++;
    });
    await execFile("sudo", ["ip", "link", "set", iface, "up"]);
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

  _markAPInterfaceReset(wlanIntfPlugin) {
    if (wlanIntfPlugin.name === this.getWifiClientInterface() || wlanIntfPlugin.name === this.getAPScanInterface())
      return;
    const band = _.get(wlanIntfPlugin, "networkConfig.band");
    // fwapc may spell 2.4 GHz as 2g, the hostapd restart is scheduled by BAND_24G
    if (band)
      this.apIntfReset[band === "2g" ? BAND_24G : band] = true;
  }

  async createWLANInterface(wlanIntfPlugin) {
    this._markAPInterfaceReset(wlanIntfPlugin);
    const macAddr = wlanIntfPlugin.networkConfig.hwAddr || await this._getWLANAddress(wlanIntfPlugin.name, wlanIntfPlugin.networkConfig.band);
    const phyName = await this._get80211PhyName();
    if (!phyName) {
      throw new Error("Failed to get 802.11 phy name");
    }
    if (!await wlanIntfPlugin.isInterfacePresent()) {
      await execFile("sudo", ["iw", "phy", phyName, "interface", "add", wlanIntfPlugin.name, "type", await this._getWLANInterfaceType(wlanIntfPlugin)]);
    }
    await execFile("sudo", ["ip", "link", "set", wlanIntfPlugin.name, "down"]).catch((err) => {});
    await execFile("sudo", ["ip", "link", "set", wlanIntfPlugin.name, "address", macAddr]).catch((err) => {});
  }

  async removeWLANInterface(wlanIntfPlugin) {
    this._markAPInterfaceReset(wlanIntfPlugin);
    await execFile("sudo", ["iw", "dev", wlanIntfPlugin.name, "del"]).catch((err) => {});
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
      baseAddress = await execFile("sudo", ["xxd", "-u", "-p", "-l", "6", "-s", String(base), "/dev/mtdblock2"]).then(result => result.stdout.trim().padStart(12, "0").match(/.{1,2}/g).join(":")).catch(() => {
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
      const output = await execFile("sudo", [`${this.getFilesPath()}/get_pdo.sh`]).then(result => result.stdout).catch(() => null);
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
    await execFile("sudo", ["systemctl", "stop", `firerouter_hostapd@${iface}`]).catch((err) => {});
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
    // a later schedule outside the sync replaces the mark, so only the sync's own restart can be skipped
    if (this.hostapdSyncKeep[band])
      this.hostapdKeepRunning[band] = this.hostapdSyncKeep[band];
    else
      delete this.hostapdKeepRunning[band];
    const task = setTimeout(() => {
      const pl = require('../../plugins/plugin_loader.js');
      // under the apply lock, as a reapply flushes and applies the band's hostapd instances one by one and a config merged in
      // between is empty or lacks the primary interface
      pl.acquireApplyLock(async () => {
        // clearTimeout cannot cancel a task already waiting for the lock, a later schedule does the work instead
        if (hostapdRestartTasks[band] !== task)
          return;
        delete hostapdRestartTasks[band];
        const keep = this.hostapdKeepRunning[band];
        delete this.hostapdKeepRunning[band];
        const bssConfigs = await this._mergeHostapdConfig(band);
        if (_.isEmpty(bssConfigs)) {
          await fsp.unlink(`${r.getUserConfigFolder()}/hostapd/band_${band}.conf`).catch((err) => {});
          log.info(`Removed hostapd config on band ${band}, stopping hostapd service`);
          await execFile("sudo", ["systemctl", "stop", `firerouter_hostapd@band_${band}`]).catch((err) => {});
          return;
        }
        await fsp.writeFile(`${r.getUserConfigFolder()}/hostapd/band_${band}.conf`, bssConfigs.join("\n"), {encoding: 'utf8'});
        if (this.apPause[band]) {
          log.info(`AP on band ${band} is paused, stop it`);
          await execFile("sudo", ["systemctl", "stop", `firerouter_hostapd@band_${band}`]).catch((err) => {});
          return;
        }
        // hostapd has to set up AP interfaces that were deleted or recreated under it, e.g. by a full reapply of the WLAN plugins
        if (keep && !this.apIntfReset[band] && await this._isAPRunningAt(bssConfigs, keep)) {
          // a restart would disconnect the AP's clients and the STA on the same radio for a channel the AP is already on
          log.info(`Updated hostapd config on band ${band}, hostapd already runs on its channel, skip restarting it`);
          return;
        }
        delete this.apIntfReset[band];
        log.info(`Updated hostapd config on band ${band}, restarting hostapd service`);
        await execFile("sudo", ["systemctl", "restart", `firerouter_hostapd@band_${band}`]).catch((err) => {});
      });
    }, 2000);
    hostapdRestartTasks[band] = task;
  }

  async _isAPRunningAt(bssConfigs, chandef) {
    const primary = bssConfigs.find(l => l.startsWith("interface="));
    const live = primary && await this._getChandef(primary.substring("interface=".length));
    return Boolean(live) && live.freq === chandef.freq && live.width === chandef.width;
  }

  pauseAP(band) {
    this.apPause[band] = true;
    this.scheduleHostapdRestart(band);
  }

  resumeAP(band) {
    delete this.apPause[band];
    this.scheduleHostapdRestart(band);
  }

  // the interface= line of the merged hostapd config is the one hostapd_cli controls the band through
  async _getPrimaryAPInterface(band) {
    const content = await fsp.readFile(`${r.getUserConfigFolder()}/hostapd/band_${band}.conf`, {encoding: 'utf8'}).catch(() => "");
    const match = content.match(/^interface=(\S+)$/m);
    return match ? match[1] : null;
  }

  // null if the interface is not on a channel, e.g. its hostapd is stopped
  async _getChandef(intf) {
    const output = await execFile("iw", ["dev", intf, "info"]).then(result => result.stdout).catch(() => "");
    const match = output.match(/channel (\d+) \((\d+) MHz\), width: (\d+) MHz[^,]*, center1: (\d+) MHz/);
    if (!match)
      return null;
    return {channel: Number(match[1]), freq: Number(match[2]), width: Number(match[3]), center1: Number(match[4])};
  }

  // enabled channels of the radio by frequency, with the DFS state ("usable", "available" or "unavailable") of those that need DFS
  async _getChannelStates() {
    const phyName = await this._get80211PhyName();
    const output = await execFile("iw", ["phy", phyName, "channels"]).then(result => result.stdout).catch(() => "");
    const states = {};
    let freq = null;
    for (const line of output.split("\n")) {
      const freqMatch = line.match(/\* (\d+) MHz \[\d+\]/);
      if (freqMatch) {
        freq = line.includes("disabled") ? null : Number(freqMatch[1]);
        if (freq)
          states[freq] = null;
        continue;
      }
      const stateMatch = line.match(/DFS state: (\w+)/);
      if (stateMatch && freq)
        states[freq] = stateMatch[1];
    }
    return states;
  }

  // chan_switch arguments for the widest bandwidth up to maxWidth that needs no CAC, null if the primary channel itself needs one.
  // 80 MHz at most, a wider AP than the uplink would not fit the STA's channel and most uplinks use 80 MHz
  async _getCSAArgs(band, freq, maxWidth) {
    if (band === BAND_24G)
      return [String(freq), "ht", "he"];
    const states = await this._getChannelStates();
    const noCAC = (f) => states.hasOwnProperty(f) && (states[f] === null || states[f] === "available");
    // 20 MHz channels are aligned to 5180 up to 144 and to 5745 from 149 on, e.g. 5180-5240 is the 80 MHz block of 36-48
    const base = freq >= 5745 ? 5745 : 5180;
    for (const width of [80, 40, 20].filter(w => w <= Math.min(maxWidth || 20, 80))) {
      const blockStart = freq - ((freq - base) % width);
      if (!_.range(blockStart, blockStart + width, 20).every(noCAC))
        continue;
      if (width === 20)
        return [String(freq), "ht", "vht", "he"];
      const center = blockStart + width / 2 - 10;
      const secOffset = ((freq - base) % 40) === 0 ? 1 : -1;
      return [String(freq), `sec_channel_offset=${secOffset}`, `center_freq1=${center}`, `bandwidth=${width}`, "ht", "vht", "he"];
    }
    return null;
  }

  // after the STA connected: the AP takes the STA's width, and without a silence period, whose end would have converted the
  // config again, the hostapd config follows the STA, as a reapply that converted it before the STA moved may have restarted
  // hostapd on the old channel, and a channel switch left the hostapd config behind the running AP
  async _followSTAChannel() {
    // first, as it needs no config lock and the AP's clients have no downlink until the AP is as wide as the STA
    const restartBand = await this._widenAPToSTA();
    const silent = [BAND_24G, BAND_5G].some(band => this.apStateAutomata.bands[band].state === STATE_AP_SILENCE);
    if (!silent) {
      const ncm = require('../../core/network_config_mgr.js');
      await ncm.acquireConfigRWLock(async () => {
        const currentConfig = await ncm.getActiveConfig();
        if (!currentConfig)
          return;
        // the AP already runs on the STA's channel and width after a channel switch or widening, its config only catches up
        const sta = await this._getChandef(this.getWifiClientInterface());
        const staBand = sta && (sta.freq >= 5000 ? BAND_5G : BAND_24G);
        if (sta) {
          const apIntf = await this._getPrimaryAPInterface(staBand);
          const ap = apIntf && await this._getChandef(apIntf);
          if (ap && ap.freq === sta.freq && ap.width === sta.width)
            this.hostapdSyncKeep[staBand] = {freq: sta.freq, width: sta.width};
        }
        const applied = await this._applyHostapdConfig(currentConfig).catch((err) => {
          log.error(`${LOG_TAG_STA_AP} Failed to apply hostapd config`, err.message);
          return false;
        }).finally(() => {
          this.hostapdSyncKeep = {};
        });
        if (!applied) {
          log.warn(`${LOG_TAG_STA_AP} Applying only hostapd for the STA channel failed, reapplying current config`);
          await ncm.tryApplyConfig(currentConfig).catch((err) => {
            log.error(`${LOG_TAG_STA_AP} Failed to reapply current config`, err.message);
          });
        }
      });
    }
    // the sync restarts it if the config changed, otherwise the AP still has to come up at the STA's width
    if (restartBand)
      this.scheduleHostapdRestart(restartBand);
  }

  // the radio's channel context takes the wider of the STA and the AP, and the AP's associated clients lose their downlink
  // when it widens under them (mt7996), so the AP is switched to the STA's width. A CAC this needs is skipped, as the range
  // is the channel the uplink AP already operates on; the AP's clients reconnect once
  // the band to restart once its config follows the STA if the AP could not be widened
  async _widenAPToSTA() {
    return lock.acquire(LOCK_AP_STATE_AUTOMATA, async () => {
      const sta = await this._getChandef(this.getWifiClientInterface());
      if (!sta || sta.width <= 20)
        return;
      const band = sta.freq >= 5000 ? BAND_5G : BAND_24G;
      if (this.apStateAutomata.bands[band].state !== STATE_NORMAL)
        return;
      const apIntf = await this._getPrimaryAPInterface(band);
      const ap = apIntf && await this._getChandef(apIntf);
      if (!ap || ap.freq !== sta.freq || ap.width >= sta.width)
        return;
      const base = sta.freq >= 5745 ? 5745 : 5180;
      const secOffset = band === BAND_24G ? (sta.center1 > sta.freq ? 1 : -1) : (((sta.freq - base) % 40) === 0 ? 1 : -1);
      const modes = band === BAND_24G ? ["ht", "he"] : ["ht", "vht", "he"];
      const hostapdCli = ["hostapd_cli", "-p", `${r.getRuntimeFolder()}/hostapd`, "-i", apIntf];
      log.info(`${LOG_TAG_STA_AP} AP band ${band} is ${ap.width} MHz under a ${sta.width} MHz STA, widening it`);
      const args = [String(sta.freq), `sec_channel_offset=${secOffset}`, `center_freq1=${sta.center1}`, `bandwidth=${sta.width}`, ...modes];
      if (!await this._chanSwitch(apIntf, args)) {
        log.warn(`${LOG_TAG_STA_AP} Failed to widen AP band ${band} to ${sta.width} MHz, it restarts once its config follows the STA`);
        return band;
      }
      for (let i = 0; i < 25; i++) {
        await util.delay(200);
        const state = await execFile("sudo", [...hostapdCli, "status"])
          .then(res => (res.stdout.match(/^state=(\S+)/m) || [])[1]).catch(() => null);
        if (state === "DFS") {
          await this.skipDFSCAC();
          continue;
        }
        const widened = await this._getChandef(apIntf);
        if (state === "ENABLED" && widened && widened.width === sta.width)
          return;
      }
      log.warn(`${LOG_TAG_STA_AP} AP band ${band} did not come back at ${sta.width} MHz`);
    });
  }

  // wpa_supplicant tries the saved uplinks one after another, and joining one on another channel of the band while the AP
  // switches makes hostapd stop the AP. A STA that is not associated is held off until func is done
  async _withSTAPaused(func) {
    const wlanIntf = this.getWifiClientInterface();
    const wpaCli = ["sudo", await this.getWpaCliBinPath(), "-p", `${r.getRuntimeFolder()}/wpa_supplicant/${wlanIntf}`, "-i", wlanIntf];
    const paused = !await this._getChandef(wlanIntf);
    if (paused)
      await execFile(wpaCli[0], [...wpaCli.slice(1), "disconnect"]).catch(() => {});
    try {
      return await func();
    } finally {
      if (paused)
        await execFile(wpaCli[0], [...wpaCli.slice(1), "reconnect"]).catch(() => {});
    }
  }

  // the radio rejects a switch while it scans, and wpa_supplicant keeps scanning while it looks for an uplink
  async _abortScans() {
    const wpaCli = await this.getWpaCliBinPath();
    await Promise.all([this.getWifiClientInterface(), this.getAPScanInterface()].map(intf =>
      execFile("sudo", [wpaCli, "-p", `${r.getRuntimeFolder()}/wpa_supplicant/${intf}`, "-i", intf, "abort_scan"]).catch(() => {})));
  }

  // send a channel switch, retrying while the radio rejects it. beforeAttempt may return a value to give up with instead.
  // true once hostapd accepted it, false if it kept rejecting it
  async _chanSwitch(apIntf, args, beforeAttempt = async () => undefined) {
    for (let i = 0; i < 10; i++) {
      if (i > 0)
        await util.delay(300);
      const early = await beforeAttempt();
      if (early !== undefined)
        return early;
      await this._abortScans();
      const accepted = await execFile("sudo", ["hostapd_cli", "-p", `${r.getRuntimeFolder()}/hostapd`, "-i", apIntf, "chan_switch", "5", ...args])
        .then(res => res.stdout.trim() === "OK").catch(() => false);
      if (accepted)
        return true;
    }
    return false;
  }

  // move the AP of the band to the STA's frequency with a channel switch announcement, so its clients follow it.
  // true if moved, null if the STA meanwhile joined the AP's channel and nothing is needed, false if the AP has to be stopped instead
  async _switchAPChannel(band, apIntf, freq, maxWidth) {
    const args = await this._getCSAArgs(band, freq, maxWidth);
    if (!args) {
      log.info(`${LOG_TAG_STA_AP} Frequency ${freq} needs a CAC, cannot switch AP channel on band ${band}`);
      return false;
    }
    const wpaCli = await this.getWpaCliBinPath();
    // wpa_supplicant tries several uplinks in a row, by the time an attempt is handled the STA may have joined another one on
    // this radio, and hostapd stops the AP after accepting a switch away from the STA's channel
    const staGuard = async () => {
      const staChandef = await this._getChandef(this.getWifiClientInterface());
      if (!staChandef || (staChandef.freq >= 5000) !== (band === BAND_5G))
        return undefined;
      const apChandef = await this._getChandef(apIntf);
      if (apChandef && apChandef.freq === staChandef.freq) {
        log.info(`${LOG_TAG_STA_AP} STA already joined ${staChandef.freq} on band ${band} where the AP is, ignore the attempt on ${freq}`);
        return null;
      }
      log.info(`${LOG_TAG_STA_AP} STA is on ${staChandef.freq} on band ${band}, cannot switch AP channel`);
      return false;
    };
    const accepted = await this._chanSwitch(apIntf, args, staGuard);
    if (accepted !== true) {
      if (accepted === false)
        log.warn(`${LOG_TAG_STA_AP} Channel switch to ${freq} not done on ${apIntf}`);
      return accepted;
    }
    for (let i = 0; i < 15; i++) {
      await util.delay(200);
      const chandef = await this._getChandef(apIntf);
      if (chandef && chandef.freq === freq) {
        // the failed attempt put the uplink on the ignore list, so the retry could pick the SSID on another band
        await execFile("sudo", [wpaCli, "-p", `${r.getRuntimeFolder()}/wpa_supplicant/${this.getWifiClientInterface()}`,
          "-i", this.getWifiClientInterface(), "bssid_ignore", "clear"]).catch(() => {});
        return true;
      }
    }
    log.warn(`${LOG_TAG_STA_AP} Channel switch to ${freq} did not complete on ${apIntf}`);
    return false;
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
              // the AP may already run on another channel than configured, e.g. after a channel switch
              const apIntf = await this._getPrimaryAPInterface(band);
              const apChandef = apIntf && await this._getChandef(apIntf);
              if (apChandef) {
                if (apChandef.channel === channel) {
                  log.info(`${LOG_TAG_STA_AP} AP band ${band} is already on channel ${channel}, same as SSID ${ssid}`);
                  return;
                }
                // moving the AP keeps its clients connected, unlike stopping it for a silence period
                const switched = await this._withSTAPaused(() => this._switchAPChannel(band, apIntf, freq, apChandef.width)).catch((err) => {
                  log.error(`${LOG_TAG_STA_AP} Failed to switch AP channel on band ${band}`, err.message);
                  return false;
                });
                if (switched) {
                  log.info(`${LOG_TAG_STA_AP} AP band ${band} switched to channel ${channel} for SSID ${ssid}`);
                  return;
                }
                if (switched === null)
                  return;
                log.info(`${LOG_TAG_STA_AP} AP band ${band} cannot switch to channel ${channel}, entering silence period`);
                stateAutomata.state = STATE_AP_SILENCE;
                stateAutomata.silenceStartTs = Date.now();
                stateAutomata.silenceEndTs = Date.now() + 45000;
                this.pauseAP(band);
                break;
              }
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
          // outside of this event, as it takes the locks and waits for the AP
          setTimeout(() => {
            this._followSTAChannel().catch((err) => {
              log.error(`${LOG_TAG_STA_AP} Failed to align AP with the STA channel`, err.message);
            });
          }, 0);
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
                if (!currentConfig)
                  return;
                // only the AP channel follows the STA here, a full reapply would also rebuild unrelated plugins and LAN DNS
                const applied = await this._applyHostapdConfig(currentConfig).catch((err) => {
                  log.error(`${LOG_TAG_STA_AP} Failed to apply hostapd config`, err.message);
                  return false;
                });
                if (applied)
                  return;
                await ncm.tryApplyConfig(currentConfig).catch((err) => {
                  log.error(`${LOG_TAG_STA_AP} Failed to reapply current config`, err.message);
                });
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

  // applies only the hostapd part of the converted config, false if the set of hostapd instances changed or applying failed,
  // so that a full reapply is needed
  async _applyHostapdConfig(config) {
    const ncm = require('../../core/network_config_mgr.js');
    const pl = require('../../plugins/plugin_loader.js');
    const converted = await ncm.convertIntegratedAPConfig(config);
    const newConfigs = (converted && converted.hostapd) || {};
    if (!_.isEqual(Object.keys(newConfigs).sort(), Object.keys(pl.getPluginInstances("hostapd") || {}).sort()))
      return false;
    const errors = await pl.reapplyInstances("hostapd", newConfigs);
    return errors !== null && _.isEmpty(errors);
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

  async prepareSelectWifi(intf, ssid, bssid) {
    return this._switchAPChannelForUplink(ssid, bssid).catch((err) => {
      log.error(`${LOG_TAG_STA_AP} Failed to switch AP channel for uplink ${ssid}`, err.message);
      return false;
    });
  }

  // the uplink's BSS from the scan the app just did, or from what the STA has seen, 5G preferred while its signal is usable
  async _findUplinkBSS(ssid, bssid) {
    const ncm = require('../../core/network_config_mgr.js');
    const wanted = (bss) => bss.ssid === ssid && bss.freq && (!bssid || bss.bssid === bssid.toUpperCase());
    let bsses = (ncm.getRecentWlanScan() || []).map(wlan => ({bssid: wlan.mac, freq: wlan.freq, signal: wlan.signal, ssid: wlan.ssid}));
    if (!bsses.some(wanted)) {
      const wlanIntf = this.getWifiClientInterface();
      const output = await execFile("sudo", [await this.getWpaCliBinPath(), "-p", `${r.getRuntimeFolder()}/wpa_supplicant/${wlanIntf}`, "-i", wlanIntf, "scan_results"])
        .then(result => result.stdout).catch(() => "");
      bsses = output.split("\n").slice(1).map(line => line.split("\t")).filter(fields => fields.length >= 5)
        .map(([mac, freq, signal, flags, name]) => ({bssid: mac.toUpperCase(), freq: Number(freq), signal: Number(signal), ssid: util.parseEscapedString(name)}));
    }
    // a BSSID the switch asks for, or the network is pinned to, is the one the STA will authenticate to
    bsses = bsses.filter(wanted);
    return _.maxBy(bsses.filter(bss => bss.freq >= 5000 && bss.signal >= -75), "signal") || _.maxBy(bsses, "signal") || null;
  }

  // move the AP to the uplink's channel before the STA tries it, so the first authentication is not rejected.
  // true if the current uplink had to be disconnected for it
  async _switchAPChannelForUplink(ssid, bssid) {
    const bss = await this._findUplinkBSS(ssid, bssid);
    if (!bss) {
      log.info(`${LOG_TAG_STA_AP} No scan result for uplink ${ssid}, the AP channel follows on the first attempt`);
      return false;
    }
    const band = bss.freq >= 5000 ? BAND_5G : BAND_24G;
    let disconnected = false;
    await lock.acquire(LOCK_AP_STATE_AUTOMATA, async () => {
      if (this.apStateAutomata.bands[band].state !== STATE_NORMAL)
        return;
      const apIntf = await this._getPrimaryAPInterface(band);
      const apChandef = apIntf && await this._getChandef(apIntf);
      if (!apChandef || apChandef.freq === bss.freq)
        return;
      // the old uplink holds the radio on its channel, the switch below would stop the AP
      const wlanIntf = this.getWifiClientInterface();
      const onBand = (chandef) => chandef && (chandef.freq >= 5000) === (band === BAND_5G);
      if (onBand(await this._getChandef(wlanIntf))) {
        await execFile("sudo", [await this.getWpaCliBinPath(), "-p", `${r.getRuntimeFolder()}/wpa_supplicant/${wlanIntf}`, "-i", wlanIntf, "disconnect"]).catch(() => {});
        disconnected = true;
        for (let i = 0; i < 10 && onBand(await this._getChandef(wlanIntf)); i++)
          await util.delay(100);
      }
      const switched = await this._switchAPChannel(band, apIntf, bss.freq, apChandef.width);
      log.info(`${LOG_TAG_STA_AP} AP band ${band} ${switched ? "switched" : "not switched"} to ${bss.freq} ahead of uplink ${ssid}`);
    });
    return disconnected;
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
    await execFile("sudo", ["cp", "-f", `${r.getFireRouterHome()}/scripts/rsyslog.d/13-mt7996e.conf`, "/etc/rsyslog.d/"]).catch((err) => { });
    const pl = require('../../plugins/plugin_loader.js');
    pl.scheduleRestartRsyslog();
  }
}

module.exports = OrangePlatform;
