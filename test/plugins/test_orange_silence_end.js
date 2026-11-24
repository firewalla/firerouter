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

describe('Test Orange AP silence end', function(){
  this.timeout(30000);

  const orig = {
    getPluginInstance: pl.getPluginInstance,
    getPluginInstances: pl.getPluginInstances,
    reapplyInstances: pl.reapplyInstances,
    acquireConfigRWLock: ncm.acquireConfigRWLock,
    getActiveConfig: ncm.getActiveConfig,
    tryApplyConfig: ncm.tryApplyConfig,
    convertIntegratedAPConfig: ncm.convertIntegratedAPConfig,
  };
  let platform;
  let staFreq;
  let hostapds;
  let converted;
  let applyResult;
  let calls;

  const params = (hw_mode, channel) => ({bridge: "br1", params: {hw_mode, channel}});
  // end the silence of band b now and run one check
  const endSilence = async (b) => {
    Object.assign(platform.apStateAutomata.bands[b], {state: "STATE_AP_SILENCE", silenceStartTs: Date.now() - 10000, silenceEndTs: Date.now() - 1});
    await platform.checkAPStateAutomata();
  };

  beforeEach(() => {
    stub.reset();
    platform = new OrangePlatform();
    clearInterval(platform.apStateAutomataTask);
    calls = [];
    applyResult = [];
    platform.pauseAP = (b) => calls.push(`pause ${b}`);
    platform.resumeAP = (b) => calls.push(`resume ${b}`);
    staFreq = 5240;
    hostapds = {
      wlan24g_a: {networkConfig: params("g", 6)},
      wlan5g_a: {networkConfig: params("a", 36)},
    };
    // fwapc ciap moves the 5G AP to the STA channel
    converted = {hostapd: {wlan24g_a: params("g", 6), wlan5g_a: params("a", 48)}};
    const wlan0 = {getWpaStatus: async () => ({freq: staFreq})};
    pl.getPluginInstance = (category, name) => category === "interface" && name === "wlan0" ? wlan0 : null;
    pl.getPluginInstances = (category) => category === "hostapd" ? hostapds : {};
    pl.reapplyInstances = async (category, configs) => {
      calls.push(`reapply ${category} ${Object.keys(configs).map(n => `${n}:${configs[n].params.channel}`).join(",")}`);
      return applyResult;
    };
    ncm.acquireConfigRWLock = async (f) => f();
    ncm.getActiveConfig = async () => ({});
    ncm.tryApplyConfig = async () => { calls.push("full reapply"); };
    ncm.convertIntegratedAPConfig = async () => converted;
  });
  afterEach(() => {
    Object.assign(pl, {getPluginInstance: orig.getPluginInstance, getPluginInstances: orig.getPluginInstances, reapplyInstances: orig.reapplyInstances});
    Object.assign(ncm, {acquireConfigRWLock: orig.acquireConfigRWLock, getActiveConfig: orig.getActiveConfig,
      tryApplyConfig: orig.tryApplyConfig, convertIntegratedAPConfig: orig.convertIntegratedAPConfig});
  });

  it('should reapply only hostapd when the AP channel follows the STA', async()=> {
    await endSilence("5g");
    expect(calls).to.eql(["reapply hostapd wlan24g_a:6,wlan5g_a:48", "resume 5g"]);
  });

  it('should restore the AP channel without a full reapply when the STA left the band', async()=> {
    staFreq = 2437;
    hostapds.wlan5g_a.networkConfig = params("a", 48);
    converted.hostapd.wlan5g_a = params("a", 36);
    await endSilence("5g");
    expect(calls).to.eql(["reapply hostapd wlan24g_a:6,wlan5g_a:36", "resume 5g"]);
  });

  it('should fall back to a full reapply when the hostapd instances changed', async()=> {
    converted.hostapd.wlan5g_b = params("a", 48);
    await endSilence("5g");
    expect(calls).to.eql(["full reapply", "resume 5g"]);
  });

  it('should fall back to a full reapply when applying hostapd fails', async()=> {
    // the loader keeps the failed instance marked, so the full reapply retries it
    applyResult = ["boom"];
    await endSilence("5g");
    expect(calls).to.eql(["reapply hostapd wlan24g_a:6,wlan5g_a:48", "full reapply", "resume 5g"]);
  });

  it('should fall back to a full reapply when an instance is gone from the loader', async()=> {
    applyResult = null;
    await endSilence("5g");
    expect(calls).to.eql(["reapply hostapd wlan24g_a:6,wlan5g_a:48", "full reapply", "resume 5g"]);
  });

  it('should fall back to a full reapply when the config cannot be converted', async()=> {
    ncm.convertIntegratedAPConfig = async () => { throw new Error("no fwapc"); };
    await endSilence("5g");
    expect(calls).to.eql(["full reapply", "resume 5g"]);
  });

  it('should not touch hostapd when the AP is already on the STA channel', async()=> {
    hostapds.wlan5g_a.networkConfig = params("a", 48);
    await endSilence("5g");
    expect(calls).to.eql(["resume 5g"]);
  });
});
