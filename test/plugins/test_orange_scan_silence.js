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
const ncm = require('../../core/network_config_mgr.js');
const OrangePlatform = stub.load(require.resolve('../../platform/orange/OrangePlatform.js'));

const SCAN_SILENCE_MS = 120000;

describe('Test Orange 5G silence on Wi-Fi scan', function(){
  this.timeout(30000);

  const orig = {
    getPluginInstance: pl.getPluginInstance,
    getPluginInstances: pl.getPluginInstances,
    acquireConfigRWLock: ncm.acquireConfigRWLock,
    getActiveConfig: ncm.getActiveConfig,
    tryApplyConfig: ncm.tryApplyConfig,
  };
  let platform;
  let wlan0;
  let hostapds;
  let apCalls;
  let reapplied;

  const band = (b) => platform.apStateAutomata.bands[b];
  const auth = (freq, ssid = "uplink") => platform.onEvent("EVENT_WPA_AUTHENTICATING", {pid: "[1]", bssid: "20:6d:31:00:00:01", ssid, freq});
  // move the end of the current silence into the past and run one check
  const expire = async (b) => {
    band(b).silenceEndTs = Date.now() - 1;
    await platform.checkAPStateAutomata();
  };

  beforeEach(() => {
    stub.reset();
    platform = new OrangePlatform();
    clearInterval(platform.apStateAutomataTask);
    apCalls = [];
    reapplied = 0;
    platform.pauseAP = (b) => apCalls.push(`pause ${b}`);
    platform.resumeAP = (b) => apCalls.push(`resume ${b}`);
    wlan0 = {
      isWAN: () => true,
      getWpaStatus: async () => ({freq: 2437}),
    };
    hostapds = {
      wlan24g_a: {networkConfig: {params: {hw_mode: "g", channel: 6}}},
      wlan5g_a: {networkConfig: {params: {hw_mode: "a", channel: 48}}},
    };
    pl.getPluginInstance = (category, name) => category === "interface" && name === "wlan0" ? wlan0 : null;
    pl.getPluginInstances = (category) => category === "hostapd" ? hostapds : {};
    ncm.acquireConfigRWLock = async (f) => f();
    ncm.getActiveConfig = async () => ({});
    ncm.tryApplyConfig = async () => { reapplied++; };
  });
  afterEach(() => {
    Object.assign(pl, {getPluginInstance: orig.getPluginInstance, getPluginInstances: orig.getPluginInstances});
    Object.assign(ncm, {acquireConfigRWLock: orig.acquireConfigRWLock, getActiveConfig: orig.getActiveConfig, tryApplyConfig: orig.tryApplyConfig});
  });

  it('should silence only 5G for two minutes on a scan', async()=> {
    const before = Date.now();
    await platform.onWifiScan();
    expect(band("5g").state).to.equal("STATE_AP_SILENCE");
    expect(band("5g").silenceEndTs).to.be.at.least(before + SCAN_SILENCE_MS);
    expect(band("2.4g").state).to.equal("STATE_NORMAL");
    expect(apCalls).to.eql(["pause 5g"]);
    // stopped right away, not only after the restart debounce
    expect(stub.calls).to.eql(["sudo systemctl stop firerouter_hostapd@band_5g"]);
  });

  it('should leave the AP alone when wlan0 is not a WAN', async()=> {
    wlan0.isWAN = () => false;
    await platform.onWifiScan();
    expect(band("5g").state).to.equal("STATE_NORMAL");
    expect(apCalls).to.eql([]);
    expect(stub.calls).to.eql([]);
  });

  it('should leave the AP alone when there is no wlan0', async()=> {
    wlan0 = null;
    await platform.onWifiScan();
    expect(band("5g").state).to.equal("STATE_NORMAL");
    expect(apCalls).to.eql([]);
  });

  it('should leave the AP alone when no 5G AP is configured', async()=> {
    delete hostapds.wlan5g_a;
    await platform.onWifiScan();
    expect(band("5g").state).to.equal("STATE_NORMAL");
    expect(apCalls).to.eql([]);
  });

  it('should extend the silence on another scan without pausing again', async()=> {
    await platform.onWifiScan();
    band("5g").silenceEndTs = Date.now() + 1000;
    const before = Date.now();
    await platform.onWifiScan();
    expect(band("5g").silenceEndTs).to.be.at.least(before + SCAN_SILENCE_MS);
    expect(apCalls).to.eql(["pause 5g"]);
    expect(stub.matching("systemctl stop").length).to.equal(1);
  });

  it('should only resume the AP when nothing tried to connect', async()=> {
    await platform.onWifiScan();
    await expire("5g");
    expect(band("5g").state).to.equal("STATE_NORMAL");
    expect(band("5g").scanTriggered).to.equal(false);
    expect(apCalls).to.eql(["pause 5g", "resume 5g"]);
    expect(reapplied).to.equal(0);
  });

  it('should not shorten the scan silence on an authentication attempt', async()=> {
    await platform.onWifiScan();
    const end = band("5g").silenceEndTs;
    await auth(5240);
    expect(band("5g").silenceEndTs).to.equal(end);
  });

  it('should end the silence 5 seconds after the WAN connects', async()=> {
    await platform.onWifiScan();
    await auth(5240);
    const before = Date.now();
    await platform.onEvent("EVENT_WPA_CONNECTED", {pid: "[1]", bssid: "20:6d:31:00:00:01", id: "0"});
    expect(band("5g").silenceEndTs).to.be.within(before + 5000, Date.now() + 5000);
  });

  it('should not extend the silence on a scan after the WAN connects', async()=> {
    await platform.onWifiScan();
    await auth(5240);
    await platform.onEvent("EVENT_WPA_CONNECTED", {pid: "[1]", bssid: "20:6d:31:00:00:01", id: "0"});
    const end = band("5g").silenceEndTs;
    await platform.onWifiScan();
    expect(band("5g").silenceEndTs).to.equal(end);
  });

  it('should keep the existing end handling after a connection attempt', async()=> {
    await platform.onWifiScan();
    // the WAN ended up on 2.4G, the 5G AP config may carry the old STA channel
    await auth(2437);
    await expire("5g");
    expect(reapplied).to.equal(1);
    expect(apCalls).to.eql(["pause 5g", "resume 5g"]);
  });

  it('should resume without reapply when the WAN connected on the AP channel', async()=> {
    wlan0.getWpaStatus = async () => ({freq: 5240});
    await platform.onWifiScan();
    await auth(5240);
    await expire("5g");
    expect(reapplied).to.equal(0);
    expect(apCalls).to.eql(["pause 5g", "resume 5g"]);
  });
});
