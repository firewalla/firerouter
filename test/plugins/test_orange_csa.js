/*    Copyright 2026 Firewalla Inc.
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

'use strict'

let chai = require('chai');
let expect = chai.expect;

const stub = require('./stub_exec.js');
const pl = require('../../plugins/plugin_loader.js');
const util = require('../../util/util.js');
const OrangePlatform = stub.load(require.resolve('../../platform/orange/OrangePlatform.js'));

// `iw phy <phy> channels` for the 5G part: 52-64 usable, 100-112 available, 116-128 usable, 132-140 usable, 144 absent
const IW_CHANNELS = [
  ...[36, 40, 44, 48].map(c => `\t\t* ${5000 + c * 5} MHz [${c}]\n\t\t  Maximum TX power: 23.0 dBm`),
  ...[52, 56, 60, 64].map(c => `\t\t* ${5000 + c * 5} MHz [${c}]\n\t\t  Radar detection\n\t\t  DFS state: usable (for 100 sec)`),
  ...[100, 104, 108, 112].map(c => `\t\t* ${5000 + c * 5} MHz [${c}]\n\t\t  Radar detection\n\t\t  DFS state: available (for 100 sec)`),
  ...[116, 120, 124, 128, 132, 136, 140].map(c => `\t\t* ${5000 + c * 5} MHz [${c}]\n\t\t  Radar detection\n\t\t  DFS state: usable (for 100 sec)`),
  ...[149, 153, 157, 161, 165].map(c => `\t\t* ${5000 + c * 5} MHz [${c}]\n\t\t  Maximum TX power: 30.0 dBm`),
  `\t\t* 5845 MHz [169] (disabled)`,
].join("\n");

describe('Test Orange AP channel switch on STA authentication', function(){
  this.timeout(30000);

  const orig = {getPluginInstances: pl.getPluginInstances, delay: util.delay};
  let platform;
  let apChandef;
  let staChandef;
  let paused;

  const auth = (freq, ssid = "uplink") => platform.onEvent("EVENT_WPA_AUTHENTICATING", {pid: "[1]", bssid: "20:6d:31:00:00:01", ssid, freq});
  const band = (b) => platform.apStateAutomata.bands[b];

  beforeEach(() => {
    stub.reset();
    stub.outputFor("iw phy", IW_CHANNELS);
    platform = new OrangePlatform();
    clearInterval(platform.apStateAutomataTask);
    paused = [];
    platform.pauseAP = (b) => paused.push(b);
    platform._get80211PhyName = async () => "phy1";
    platform.getWpaCliBinPath = async () => "wpa_cli";
    platform._getPrimaryAPInterface = async (b) => b === "5g" ? "wlan5g_a" : "wlan24g_a";
    apChandef = {channel: 36, freq: 5180, width: 160, center1: 5250};
    // the AP reports the new frequency once the switch has been issued
    staChandef = null;
    platform._getChandef = async (intf) => {
      if (intf === "wlan0")
        return stub.matching("wlan0 disconnect").length > 0 ? null : staChandef;
      if (!apChandef)
        return null;
      const switched = platform._switchedTo && stub.matching("chan_switch").length > 0;
      return switched ? Object.assign({}, apChandef, {freq: platform._switchedTo}) : apChandef;
    };
    stub.outputFor("chan_switch", "OK");
    pl.getPluginInstances = (category) => category === "hostapd" ? {wlan5g_a: {networkConfig: {params: {hw_mode: "a", channel: 0}}}} : {};
    util.delay = async () => {};
  });
  afterEach(() => {
    pl.getPluginInstances = orig.getPluginInstances;
    util.delay = orig.delay;
  });

  describe('channel switch arguments', function() {
    it('should switch 2.4G at 20 MHz', async() => {
      expect(await platform._getCSAArgs("2.4g", 2412, 40)).to.eql(["2412", "ht", "he"]);
    });
    it('should narrow to 80 MHz and stay off usable DFS channels', async() => {
      expect(await platform._getCSAArgs("5g", 5200, 160)).to.eql(["5200", "sec_channel_offset=-1", "center_freq1=5210", "bandwidth=80", "ht", "vht", "he"]);
    });
    it('should use available DFS channels', async() => {
      expect(await platform._getCSAArgs("5g", 5500, 160)).to.eql(["5500", "sec_channel_offset=1", "center_freq1=5530", "bandwidth=80", "ht", "vht", "he"]);
    });
    it('should give up when the primary channel needs a CAC', async() => {
      expect(await platform._getCSAArgs("5g", 5260, 160)).to.equal(null);
      expect(await platform._getCSAArgs("5g", 5580, 80)).to.equal(null);
    });
    it('should align channels from 149 on to 5745', async() => {
      expect(await platform._getCSAArgs("5g", 5745, 80)).to.eql(["5745", "sec_channel_offset=1", "center_freq1=5775", "bandwidth=80", "ht", "vht", "he"]);
      expect(await platform._getCSAArgs("5g", 5805, 80)).to.eql(["5805", "sec_channel_offset=-1", "center_freq1=5775", "bandwidth=80", "ht", "vht", "he"]);
    });
    it('should not go wider than the AP', async() => {
      expect(await platform._getCSAArgs("5g", 5200, 40)).to.eql(["5200", "sec_channel_offset=-1", "center_freq1=5190", "bandwidth=40", "ht", "vht", "he"]);
      expect(await platform._getCSAArgs("5g", 5200, 20)).to.eql(["5200", "ht", "vht", "he"]);
    });
    it('should fall back to 20 MHz when a channel of the block is disabled', async() => {
      // 165 has no 40 MHz partner on this radio, 169 is disabled
      expect(await platform._getCSAArgs("5g", 5825, 80)).to.eql(["5825", "ht", "vht", "he"]);
    });
  });

  describe('authentication on another channel', function() {
    it('should switch the AP instead of stopping it', async() => {
      platform._switchedTo = 5200;
      await auth(5200);
      expect(stub.matching("chan_switch")).to.eql(["sudo hostapd_cli -p " + require('../../util/firerouter.js').getRuntimeFolder() + "/hostapd -i wlan5g_a chan_switch 5 5200 sec_channel_offset=-1 center_freq1=5210 bandwidth=80 ht vht he"]);
      expect(stub.matching("bssid_ignore clear").length).to.equal(1);
      // the STA is held off around the switch so it cannot join another uplink meanwhile
      const wpa = stub.calls.filter(c => / (disconnect|chan_switch|reconnect)/.test(c)).map(c => c.split(" ").find(w => ["disconnect", "chan_switch", "reconnect"].includes(w)));
      expect(wpa).to.eql(["disconnect", "chan_switch", "reconnect"]);
      // scans block the switch, both the STA and the scan interface are asked to stop
      expect(stub.matching("abort_scan").map(c => c.split(" -i ")[1])).to.eql(["wlan0 abort_scan", "wlan_ap_scan abort_scan"]);
      expect(paused).to.eql([]);
      expect(band("5g").state).to.equal("STATE_NORMAL");
    });
    it('should do nothing when the AP already runs on the channel', async() => {
      apChandef = {channel: 40, freq: 5200, width: 80, center1: 5210};
      await auth(5200);
      expect(stub.matching("chan_switch")).to.eql([]);
      expect(paused).to.eql([]);
    });
    it('should stop the AP when the primary channel needs a CAC', async() => {
      await auth(5260);
      expect(stub.matching("chan_switch")).to.eql([]);
      expect(paused).to.eql(["5g"]);
      expect(band("5g").state).to.equal("STATE_AP_SILENCE");
    });
    it('should stop the AP when the switch keeps being rejected', async() => {
      stub.outputFor("chan_switch", "FAIL");
      await auth(5200);
      expect(stub.matching("chan_switch").length).to.equal(10);
      expect(paused).to.eql(["5g"]);
      expect(band("5g").state).to.equal("STATE_AP_SILENCE");
    });
    it('should stop the AP when the switch does not complete', async() => {
      platform._switchedTo = null;
      await auth(5200);
      expect(stub.matching("bssid_ignore")).to.eql([]);
      expect(paused).to.eql(["5g"]);
    });
    it('should ignore a stale attempt when the STA already joined the AP channel', async() => {
      // another uplink on the AP's channel was joined while this attempt waited in the queue
      apChandef = {channel: 36, freq: 5180, width: 80, center1: 5210};
      staChandef = {channel: 36, freq: 5180, width: 80, center1: 5210};
      await auth(5200);
      expect(stub.matching("chan_switch")).to.eql([]);
      expect(paused).to.eql([]);
      expect(band("5g").state).to.equal("STATE_NORMAL");
    });
    it('should not hold off a STA that is already associated', async() => {
      apChandef = {channel: 36, freq: 5180, width: 80, center1: 5210};
      staChandef = {channel: 36, freq: 5180, width: 80, center1: 5210};
      await auth(5200);
      expect(stub.matching(" disconnect")).to.eql([]);
      expect(stub.matching(" reconnect")).to.eql([]);
    });
    it('should stop the AP when the STA is on another channel of the band than the AP', async() => {
      staChandef = {channel: 44, freq: 5220, width: 80, center1: 5210};
      await auth(5200);
      expect(stub.matching("chan_switch")).to.eql([]);
      expect(paused).to.eql(["5g"]);
    });
    it('should switch when the STA is associated on the other band', async() => {
      platform._switchedTo = 5200;
      staChandef = {channel: 6, freq: 2437, width: 20, center1: 2437};
      await auth(5200);
      expect(stub.matching("chan_switch").length).to.equal(1);
      expect(paused).to.eql([]);
    });
    it('should keep the configured channel check when the AP is not running', async() => {
      apChandef = null;
      await auth(5200);
      expect(stub.matching("chan_switch")).to.eql([]);
      expect(paused).to.eql(["5g"]);
    });
  });

  describe('channel switch ahead of an uplink', function() {
    const SCAN = "bssid / frequency / signal level / flags / ssid\n" + [
      "20:6d:31:61:00:0e\t2432\t-30\t[WPA2-PSK-CCMP][ESS]\tTerryGold",
      "20:6d:31:61:00:0f\t5200\t-50\t[WPA2-PSK-CCMP][ESS]\tTerryGold",
      "20:6d:31:ef:b3:70\t2412\t-40\t[WPA2-PSK-CCMP][ESS]\tterry\\x20Purple",
    ].join("\n");
    const ncm = require('../../core/network_config_mgr.js');
    beforeEach(() => {
      stub.outputFor("scan_results", SCAN);
      platform._switchedTo = 5200;
      ncm.lastWlanScan = null;
    });
    afterEach(() => {
      ncm.lastWlanScan = null;
    });

    it('should move the 5G AP to the uplink before the STA tries it, even when 2.4G is stronger', async() => {
      await platform.prepareSelectWifi("wlan0", "TerryGold");
      expect(stub.matching("chan_switch")).to.have.lengthOf(1);
      expect(stub.matching("chan_switch")[0]).to.include("wlan5g_a chan_switch 5 5200 ");
      expect(paused).to.eql([]);
    });
    it('should disconnect the old uplink on the same band first and report it', async() => {
      staChandef = {channel: 36, freq: 5180, width: 80, center1: 5210};
      expect(await platform.prepareSelectWifi("wlan0", "TerryGold")).to.equal(true);
      expect(stub.matching("disconnect")).to.have.lengthOf(1);
      expect(stub.matching("chan_switch")).to.have.lengthOf(1);
    });
    it('should use 2.4G when the uplink has no usable 5G', async() => {
      platform._switchedTo = 2412;
      apChandef = {channel: 6, freq: 2437, width: 20, center1: 2437};
      await platform.prepareSelectWifi("wlan0", "terry Purple");
      expect(stub.matching("chan_switch")).to.eql([stub.matching("chan_switch")[0]]);
      expect(stub.matching("chan_switch")[0]).to.include("wlan24g_a chan_switch 5 2412 ");
    });
    it('should prefer the scan the app just did over what the STA has seen', async() => {
      platform._switchedTo = 5240;
      ncm.lastWlanScan = {ts: Date.now(), wlans: [
        {mac: "20:6D:31:EF:B3:70", freq: 5240, signal: -40, flags: [], ssid: "terryPurple"},
        {mac: "20:6D:31:EF:B3:71", freq: 2412, signal: -20, flags: [], ssid: "terryPurple"},
      ]};
      await platform.prepareSelectWifi("wlan0", "terryPurple");
      expect(stub.matching("scan_results")).to.eql([]);
      expect(stub.matching("chan_switch")[0]).to.include("wlan5g_a chan_switch 5 5240 ");
    });
    it('should use the BSSID the switch asks for', async() => {
      platform._switchedTo = 2432;
      apChandef = {channel: 6, freq: 2437, width: 20, center1: 2437};
      expect(await platform.prepareSelectWifi("wlan0", "TerryGold", "20:6d:31:61:00:0e")).to.equal(false);
      expect(stub.matching("chan_switch")[0]).to.include("wlan24g_a chan_switch 5 2432 ");
    });
    it('should ignore an old scan', async() => {
      ncm.lastWlanScan = {ts: Date.now() - 700000, wlans: [{mac: "x", freq: 5240, signal: -40, flags: [], ssid: "TerryGold"}]};
      await platform.prepareSelectWifi("wlan0", "TerryGold");
      // falls back to the STA's results, where TerryGold is on 5200
      expect(stub.matching("chan_switch")[0]).to.include("wlan5g_a chan_switch 5 5200 ");
    });
    it('should leave the AP alone without a scan result or when it is already there', async() => {
      await platform.prepareSelectWifi("wlan0", "Unknown");
      apChandef = {channel: 40, freq: 5200, width: 80, center1: 5210};
      await platform.prepareSelectWifi("wlan0", "TerryGold");
      expect(stub.matching("chan_switch")).to.eql([]);
      expect(stub.matching("disconnect")).to.eql([]);
    });
  });

  describe('widening the AP to the STA', function() {
    beforeEach(() => {
      platform.skipDFSCAC = async () => { stub.calls.push("skip cac"); };
      // the AP comes back at the STA's width once the switch was issued
      platform._getChandef = async (intf) => {
        if (intf === "wlan0")
          return staChandef;
        return stub.matching("chan_switch").length && widenedAP ? widenedAP : apChandef;
      };
    });
    let widenedAP;

    it('should switch a narrower 5G AP to the STA width and skip the CAC within the uplink channel', async() => {
      staChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
      apChandef = {channel: 40, freq: 5200, width: 80, center1: 5210};
      widenedAP = staChandef;
      // the AP waits for a CAC, which is over once it is skipped
      stub.outputFor("status", "state=DFS\n");
      platform.skipDFSCAC = async () => { stub.calls.push("skip cac"); stub.outputFor("status", "state=ENABLED\n"); };
      await platform._widenAPToSTA();
      expect(stub.matching("chan_switch")[0]).to.include("wlan5g_a chan_switch 5 5200 sec_channel_offset=-1 center_freq1=5250 bandwidth=160 ht vht he");
      expect(stub.calls).to.include("skip cac");
    });
    it('should restart the AP at the STA width when widening keeps being rejected', async() => {
      staChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
      apChandef = {channel: 40, freq: 5200, width: 80, center1: 5210};
      stub.outputFor("chan_switch", "FAIL");
      expect(await platform._widenAPToSTA()).to.equal("5g");
      expect(stub.matching("chan_switch").length).to.equal(10);
      expect(stub.matching("abort_scan").length).to.equal(20);
    });
    it('should restart the AP when it does not come back at the STA width after the switch', async() => {
      staChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
      apChandef = {channel: 40, freq: 5200, width: 80, center1: 5210};
      widenedAP = null;
      stub.outputFor("status", "state=ENABLED\n");
      expect(await platform._widenAPToSTA()).to.equal("5g");
      expect(stub.matching("chan_switch")).to.have.lengthOf(1);
      expect(stub.matching(" status")).to.have.lengthOf(25);
    });
    it('should not restart the AP once it is back at the STA width', async() => {
      staChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
      apChandef = {channel: 40, freq: 5200, width: 80, center1: 5210};
      widenedAP = staChandef;
      stub.outputFor("status", "state=ENABLED\n");
      expect(await platform._widenAPToSTA()).to.equal(undefined);
    });
    it('should widen a 2.4G AP to a 40 MHz STA', async() => {
      staChandef = {channel: 5, freq: 2432, width: 40, center1: 2442};
      apChandef = {channel: 5, freq: 2432, width: 20, center1: 2432};
      widenedAP = staChandef;
      stub.outputFor("status", "state=ENABLED\n");
      await platform._widenAPToSTA();
      expect(stub.matching("chan_switch")[0]).to.include("wlan24g_a chan_switch 5 2432 sec_channel_offset=1 center_freq1=2442 bandwidth=40 ht he");
    });
    it('should leave the AP alone when it is as wide, on another primary channel or not running', async() => {
      staChandef = {channel: 40, freq: 5200, width: 80, center1: 5210};
      apChandef = {channel: 40, freq: 5200, width: 80, center1: 5210};
      await platform._widenAPToSTA();
      apChandef = {channel: 48, freq: 5240, width: 80, center1: 5210};
      staChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
      await platform._widenAPToSTA();
      apChandef = null;
      await platform._widenAPToSTA();
      expect(stub.matching("chan_switch")).to.eql([]);
    });
  });

  describe('following the STA channel after it connected', function() {
    const ncm = require('../../core/network_config_mgr.js');
    const origNcm = {acquireConfigRWLock: ncm.acquireConfigRWLock, getActiveConfig: ncm.getActiveConfig};
    let steps;
    beforeEach(() => {
      steps = [];
      ncm.acquireConfigRWLock = async (f) => { steps.push("lock"); return f(); };
      ncm.getActiveConfig = async () => ({});
      platform._applyHostapdConfig = async () => { steps.push("hostapd"); return true; };
      platform._widenAPToSTA = async () => { steps.push("widen"); };
    });
    afterEach(() => {
      Object.assign(ncm, origNcm);
    });

    it('should widen the AP first, then bring the hostapd config to the STA channel', async() => {
      await platform._followSTAChannel();
      expect(steps).to.eql(["widen", "lock", "hostapd"]);
    });
    it('should reapply the whole config when applying only hostapd fails', async() => {
      platform._applyHostapdConfig = async () => { steps.push("hostapd"); return false; };
      const origTry = ncm.tryApplyConfig;
      ncm.tryApplyConfig = async () => { steps.push("full"); };
      try {
        await platform._followSTAChannel();
      } finally {
        ncm.tryApplyConfig = origTry;
      }
      expect(steps).to.eql(["widen", "lock", "hostapd", "full"]);
    });
    it('should restart the AP only after the config sync when widening failed', async() => {
      platform._widenAPToSTA = async () => { steps.push("widen"); return "5g"; };
      platform.scheduleHostapdRestart = (b) => steps.push(`restart ${b}`);
      await platform._followSTAChannel();
      expect(steps).to.eql(["widen", "lock", "hostapd", "restart 5g"]);
    });
    it('should let only the config sync keep an AP that already runs at the STA channel and width', async() => {
      staChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
      apChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
      let seen;
      platform._applyHostapdConfig = async () => { seen = Object.assign({}, platform.hostapdSyncKeep); return true; };
      await platform._followSTAChannel();
      expect(seen).to.eql({"5g": {freq: 5200, width: 160}});
      expect(platform.hostapdSyncKeep).to.eql({});
    });
    it('should not keep an AP that is not at the STA width, nor after a failed sync', async() => {
      staChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
      apChandef = {channel: 40, freq: 5200, width: 80, center1: 5210};
      let seen;
      platform._applyHostapdConfig = async () => { seen = Object.assign({}, platform.hostapdSyncKeep); return true; };
      await platform._followSTAChannel();
      expect(seen).to.eql({});
      apChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
      const origTry = ncm.tryApplyConfig;
      ncm.tryApplyConfig = async () => { seen = Object.assign({}, platform.hostapdSyncKeep); };
      platform._applyHostapdConfig = async () => { throw new Error("boom"); };
      try {
        await platform._followSTAChannel();
      } finally {
        ncm.tryApplyConfig = origTry;
      }
      expect(seen).to.eql({});
    });
    it('should leave the config to the end of a silence period', async() => {
      platform.apStateAutomata.bands["2.4g"].state = "STATE_AP_SILENCE";
      await platform._followSTAChannel();
      expect(steps).to.eql(["widen"]);
    });
  });

  describe('hostapd restart', function() {
    this.timeout(20000);
    const fsp = require('fs').promises;
    const origFs = {writeFile: fsp.writeFile, unlink: fsp.unlink};
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const restarts = () => stub.matching("systemctl");
    beforeEach(() => {
      fsp.writeFile = async () => {};
      fsp.unlink = async () => {};
      platform._mergeHostapdConfig = async () => ["interface=wlan5g_a", "channel=40", ""];
      apChandef = {channel: 40, freq: 5200, width: 160, center1: 5250};
    });
    afterEach(() => {
      Object.assign(fsp, origFs);
    });

    it('should restart for a config change', async() => {
      platform.scheduleHostapdRestart("5g");
      await sleep(2300);
      expect(restarts()).to.eql(["sudo systemctl restart firerouter_hostapd@band_5g"]);
    });
    // as _followSTAChannel does around its apply
    const scheduleFromSync = (keep) => {
      platform.hostapdSyncKeep["5g"] = keep;
      platform.scheduleHostapdRestart("5g");
      platform.hostapdSyncKeep = {};
    };
    it('should keep an AP running where the config sync expects it, once', async() => {
      scheduleFromSync({freq: 5200, width: 160});
      await sleep(2300);
      expect(restarts()).to.eql([]);
      expect(platform.hostapdKeepRunning["5g"]).to.equal(undefined);
      platform.scheduleHostapdRestart("5g");
      await sleep(2300);
      expect(restarts()).to.eql(["sudo systemctl restart firerouter_hostapd@band_5g"]);
    });
    it('should restart when a later change replaces the restart of the config sync', async() => {
      // e.g. the STA moved to 2.4 GHz and its sync converted the 5 GHz AP back to its configured channel
      scheduleFromSync({freq: 5200, width: 160});
      platform.scheduleHostapdRestart("5g");
      await sleep(2300);
      expect(restarts()).to.eql(["sudo systemctl restart firerouter_hostapd@band_5g"]);
    });
    it('should restart when the AP is not where the sync expects it, or its interfaces were recreated', async() => {
      scheduleFromSync({freq: 5200, width: 80});
      await sleep(2300);
      expect(restarts().length).to.equal(1);
      platform._markAPInterfaceReset({name: "wlan5g_a", networkConfig: {band: "5g"}});
      scheduleFromSync({freq: 5200, width: 160});
      await sleep(2300);
      expect(restarts().length).to.equal(2);
    });
    it('should decide only once a running apply is done', async() => {
      let release;
      const held = pl.acquireApplyLock(() => new Promise(resolve => { release = resolve; }));
      platform.scheduleHostapdRestart("5g");
      await sleep(2300);
      expect(restarts()).to.eql([]);
      release();
      await held;
      await sleep(100);
      expect(restarts()).to.eql(["sudo systemctl restart firerouter_hostapd@band_5g"]);
    });
    it('should run only the latest of the tasks that waited for the apply lock', async() => {
      // the sync applies two AP instances of the band, the first restart task fires while the sync still holds the lock
      let release;
      const held = pl.acquireApplyLock(() => new Promise(resolve => { release = resolve; }));
      scheduleFromSync({freq: 5200, width: 160});
      await sleep(2300);
      scheduleFromSync({freq: 5200, width: 160});
      await sleep(2300);
      release();
      await held;
      await sleep(100);
      expect(restarts()).to.eql([]);
      const held2 = pl.acquireApplyLock(() => new Promise(resolve => { release = resolve; }));
      scheduleFromSync({freq: 5200, width: 160});
      await sleep(2300);
      platform.scheduleHostapdRestart("5g");
      await sleep(2300);
      release();
      await held2;
      await sleep(100);
      expect(restarts()).to.eql(["sudo systemctl restart firerouter_hostapd@band_5g"]);
    });
    it('should treat 2g as the 2.4 GHz band when marking recreated AP interfaces', async() => {
      platform._markAPInterfaceReset({name: "wlan24g_a", networkConfig: {band: "2g"}});
      platform._markAPInterfaceReset({name: "wlan0", networkConfig: {band: "5g"}});
      expect(platform.apIntfReset).to.eql({"2.4g": true});
    });
  });
});
