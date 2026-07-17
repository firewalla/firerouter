/*    Copyright 2016-2026 Firewalla Inc.
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

const chai = require('chai');
const expect = chai.expect;
const _ = require('lodash');
const fsp = require('fs').promises;

const ncm = require('../../core/network_config_mgr.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();
const rclient = require('../../util/redis_manager').getRedisClient();

// a minimal 3-port onboard network, eth0 as wan
const onboardNetwork = () => JSON.parse(JSON.stringify({
  interface: {
    phy: {
      eth0: {meta: {name: "WAN", type: "wan"}, enabled: true, dhcp: true},
      eth1: {enabled: true},
      eth2: {enabled: true}
    },
    bridge: {
      br0: {meta: {name: "LAN", type: "lan"}, ipv4: "10.10.0.1/24", intf: ["eth1", "eth2"], enabled: true}
    }
  },
  routing: {global: {default: {viaIntf: "eth0"}}},
  nat: {br0_eth0: {in: "br0", out: "eth0"}},
  sshd: {eth0: {enabled: true}, br0: {enabled: true}}
}));

describe('Test onboard config consumption', function() {
  this.timeout(30000);

  let origGetIntfNameByMac, origReadOnboardConfig, origIsOnboardConfigSupported;

  beforeEach(() => {
    origGetIntfNameByMac = ncm.getIntfNameByMac;
    origReadOnboardConfig = ncm.readOnboardConfig;
    origIsOnboardConfigSupported = platform.isOnboardConfigSupported;
  });

  afterEach(() => {
    ncm.getIntfNameByMac = origGetIntfNameByMac;
    ncm.readOnboardConfig = origReadOnboardConfig;
    platform.isOnboardConfigSupported = origIsOnboardConfigSupported;
  });

  describe('correctWanByMac', () => {
    it('should move wan to the iface owning the MAC, including all name references', async () => {
      ncm.getIntfNameByMac = async (mac) => mac === "dd:dd:dd:dd:dd:dd" ? "eth3" : null;
      const fixed = await ncm.correctWanByMac(onboardNetwork(), " DD:DD:DD:DD:DD:DD ");
      expect(_.get(fixed, ["interface", "phy", "eth3", "meta", "type"])).to.equal("wan");
      expect(_.get(fixed, ["interface", "phy", "eth3", "dhcp"])).to.be.true;
      expect(_.get(fixed, ["interface", "phy", "eth0"])).to.be.undefined;
      expect(_.get(fixed, ["interface", "bridge", "br0", "intf"])).to.eql(["eth1", "eth2"]);
      expect(_.get(fixed, ["routing", "global", "default", "viaIntf"])).to.equal("eth3");
      expect(_.get(fixed, ["nat", "br0_eth0", "out"])).to.equal("eth3");
      expect(_.get(fixed, ["sshd", "eth3", "enabled"])).to.be.true;
      expect(_.get(fixed, ["sshd", "eth0"])).to.be.undefined;
    });

    it('should exchange roles when the real wan port is already used in config', async () => {
      ncm.getIntfNameByMac = async () => "eth2";
      const fixed = await ncm.correctWanByMac(onboardNetwork(), "cc:cc:cc:cc:cc:cc");
      expect(_.get(fixed, ["interface", "phy", "eth2", "meta", "type"])).to.equal("wan");
      expect(_.get(fixed, ["interface", "phy", "eth0"])).to.eql({enabled: true});
      expect(_.get(fixed, ["interface", "bridge", "br0", "intf"])).to.eql(["eth1", "eth0"]);
    });

    it('should be a no-op when the MAC owner matches the configured wan', async () => {
      ncm.getIntfNameByMac = async () => "eth0";
      const config = onboardNetwork();
      const fixed = await ncm.correctWanByMac(config, "aa:aa:aa:aa:aa:aa");
      expect(fixed).to.eql(onboardNetwork());
    });

    it('should be a no-op when no iface owns the MAC', async () => {
      ncm.getIntfNameByMac = async () => null;
      const fixed = await ncm.correctWanByMac(onboardNetwork(), "ff:ff:ff:ff:ff:ff");
      expect(fixed).to.eql(onboardNetwork());
    });

    it('should be a no-op without a wanMac', async () => {
      const fixed = await ncm.correctWanByMac(onboardNetwork(), undefined);
      expect(fixed).to.eql(onboardNetwork());
    });

    it('should skip correction when config has multiple wans', async () => {
      ncm.getIntfNameByMac = async () => "eth2";
      const config = onboardNetwork();
      config.interface.phy.eth1 = {meta: {name: "WAN2", type: "wan"}, enabled: true, dhcp: true};
      const fixed = await ncm.correctWanByMac(config, "cc:cc:cc:cc:cc:cc");
      expect(fixed).to.eql(config);
    });

    it('should converge when correcting an already-corrected config', async () => {
      ncm.getIntfNameByMac = async () => "eth3";
      const fixed = await ncm.correctWanByMac(onboardNetwork(), "dd:dd:dd:dd:dd:dd");
      const again = await ncm.correctWanByMac(fixed, "dd:dd:dd:dd:dd:dd");
      expect(again).to.eql(fixed);
    });
  });

  describe('getDefaultConfig', () => {
    it('should fall back to default setup when onboard network is invalid', async () => {
      platform.isOnboardConfigSupported = () => true;
      const invalid = onboardNetwork();
      // duplicate subnet on two lan bridges fails validateConfig
      invalid.interface.bridge.br1 = {meta: {name: "LAN2", type: "lan"}, ipv4: "10.10.0.2/24", intf: [], enabled: true};
      ncm.readOnboardConfig = async () => ({parsed: {network: invalid}, raw: JSON.stringify({network: invalid}), path: "/tmp/nonexistent.json"});
      const config = await ncm.getDefaultConfig();
      expect(config).to.eql(require('../../network/default_setup.json'));
    });
  });

  describe('consumeOnboardConfig', () => {
    // redis and saveConfig are fully stubbed, live box config is never touched
    const testFile = "/tmp/test-onboard-config.json";
    let origSaveConfig, origGetAsync, origSetAsync;
    let savedConfig, hashStore;

    beforeEach(async () => {
      savedConfig = null;
      hashStore = {};
      origSaveConfig = ncm.saveConfig;
      origGetAsync = rclient.getAsync;
      origSetAsync = rclient.setAsync;
      ncm.saveConfig = async (config) => { savedConfig = config; };
      rclient.getAsync = async (key) => key === "sysdb:onboardConfigHash" ? (hashStore[key] || null) : origGetAsync.call(rclient, key);
      rclient.setAsync = async (key, value) => { hashStore[key] = value; return "OK"; };
      const content = {network: onboardNetwork(), provision: {wanMac: "dd:dd:dd:dd:dd:dd"}, license: {uuid: "test"}};
      await fsp.writeFile(testFile, JSON.stringify(content, null, 2));
      platform.isOnboardConfigSupported = () => true;
      ncm.getIntfNameByMac = async (mac) => mac === "dd:dd:dd:dd:dd:dd" ? "eth3" : null;
      ncm.readOnboardConfig = async () => {
        const raw = await fsp.readFile(testFile, {encoding: "utf8"});
        return {parsed: JSON.parse(raw), raw, path: testFile};
      };
    });

    afterEach(async () => {
      ncm.saveConfig = origSaveConfig;
      rclient.getAsync = origGetAsync;
      rclient.setAsync = origSetAsync;
      await fsp.unlink(testFile).catch(() => undefined);
    });

    it('should consume once, rewrite the file with corrected wan, then no-op', async () => {
      const consumed = await ncm.consumeOnboardConfig();
      expect(consumed).to.be.true;
      // file rewritten with wan on eth3, other sections preserved
      const rewritten = JSON.parse(await fsp.readFile(testFile, {encoding: "utf8"}));
      expect(_.get(rewritten, ["network", "interface", "phy", "eth3", "meta", "type"])).to.equal("wan");
      expect(_.get(rewritten, ["license", "uuid"])).to.equal("test");
      expect(_.get(rewritten, ["provision", "wanMac"])).to.equal("dd:dd:dd:dd:dd:dd");
      // corrected config saved as active config
      expect(_.get(savedConfig, ["interface", "phy", "eth3", "meta", "type"])).to.equal("wan");
      // second run is a no-op
      const consumedAgain = await ncm.consumeOnboardConfig();
      expect(consumedAgain).to.be.false;
    });

    it('should not consume nor rewrite when onboard network is invalid', async () => {
      const content = {network: onboardNetwork(), provision: {wanMac: "dd:dd:dd:dd:dd:dd"}};
      content.network.interface.bridge.br1 = {meta: {name: "LAN2", type: "lan"}, ipv4: "10.10.0.2/24", intf: [], enabled: true};
      await fsp.writeFile(testFile, JSON.stringify(content, null, 2));
      const before = await fsp.readFile(testFile, {encoding: "utf8"});
      const consumed = await ncm.consumeOnboardConfig();
      expect(consumed).to.be.false;
      expect(savedConfig).to.be.null;
      expect(await fsp.readFile(testFile, {encoding: "utf8"})).to.equal(before);
      expect(hashStore).to.eql({});
    });
  });
});
