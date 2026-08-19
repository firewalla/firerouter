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
const op = require('../../core/onboard_profile.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();
const rclient = require('../../util/redis_manager').getRedisClient();

// the compact block the cloud emits: it knows the wan method and the lan subnet, not the port count
const adaptiveNetwork = (wan) => JSON.parse(JSON.stringify({
  profile: "adaptive",
  wan: wan || {type: "dhcp"},
  lan: {ip: "192.168.49.1", mask: "255.255.255.0"}
}));

const ports = (n) => Array.from({length: n}, (_v, i) => `eth${i}`);

describe('Test onboard network profile', function() {
  this.timeout(30000);

  describe('maskToPrefix', () => {
    it('should convert valid netmasks', () => {
      expect(op.maskToPrefix("255.255.255.0")).to.equal(24);
      expect(op.maskToPrefix("255.255.0.0")).to.equal(16);
      expect(op.maskToPrefix("255.255.255.252")).to.equal(30);
      expect(op.maskToPrefix("0.0.0.0")).to.equal(0);
    });

    it('should reject non-contiguous or malformed masks', () => {
      expect(op.maskToPrefix("255.0.255.0")).to.be.null;
      expect(op.maskToPrefix("255.255.255")).to.be.null;
      expect(op.maskToPrefix("256.255.255.0")).to.be.null;
      expect(op.maskToPrefix("not-a-mask")).to.be.null;
    });
  });

  describe('expandProfile', () => {
    it('should make eth0 the wan and bridge every other port', () => {
      const config = op.expandProfile(adaptiveNetwork(), ports(4));
      expect(_.get(config, ["interface", "phy", "eth0", "meta", "type"])).to.equal("wan");
      expect(_.get(config, ["interface", "phy", "eth0", "dhcp"])).to.be.true;
      expect(_.get(config, ["interface", "bridge", "br0", "intf"])).to.eql(["eth1", "eth2", "eth3"]);
      expect(_.get(config, ["interface", "bridge", "br0", "ipv4"])).to.equal("192.168.49.1/24");
      expect(_.get(config, ["routing", "global", "default", "viaIntf"])).to.equal("eth0");
      expect(_.get(config, ["nat", "br0_eth0"])).to.eql({in: "br0", out: "eth0"});
      expect(_.get(config, ["dhcp", "br0", "range"])).to.eql({from: "192.168.49.10", to: "192.168.49.250"});
      expect(_.get(config, ["dhcp", "br0", "gateway"])).to.equal("192.168.49.1");
      // every lan member is declared as an enabled phy
      for (const intf of ["eth1", "eth2", "eth3"])
        expect(_.get(config, ["interface", "phy", intf])).to.eql({enabled: true});
    });

    it('should adapt to any port count', () => {
      expect(_.get(op.expandProfile(adaptiveNetwork(), ports(10)), ["interface", "bridge", "br0", "intf"]))
        .to.eql(["eth1", "eth2", "eth3", "eth4", "eth5", "eth6", "eth7", "eth8", "eth9"]);
      expect(_.get(op.expandProfile(adaptiveNetwork(), ports(2)), ["interface", "bridge", "br0", "intf"]))
        .to.eql(["eth1"]);
      expect(_.get(op.expandProfile(adaptiveNetwork(), ports(1)), ["interface", "bridge", "br0", "intf"]))
        .to.eql([]);
    });

    it('should sort ports numerically rather than lexically', () => {
      const config = op.expandProfile(adaptiveNetwork(), ["eth10", "eth2", "eth0", "eth1"]);
      expect(_.get(config, ["interface", "bridge", "br0", "intf"])).to.eql(["eth1", "eth2", "eth10"]);
    });

    it('should ignore interfaces that are not ethernet ports', () => {
      const config = op.expandProfile(adaptiveNetwork(), ["eth0", "eth1", "wlan0", "usb0"]);
      expect(_.get(config, ["interface", "bridge", "br0", "intf"])).to.eql(["eth1"]);
      expect(_.get(config, ["interface", "phy", "wlan0"])).to.be.undefined;
    });

    it('should build a static wan', () => {
      const config = op.expandProfile(adaptiveNetwork({
        type: "static", ip: "203.0.113.5", mask: "255.255.255.0", gateway: "203.0.113.1", dns: "1.1.1.1"
      }), ports(3));
      const wan = _.get(config, ["interface", "phy", "eth0"]);
      expect(wan.ipv4).to.equal("203.0.113.5/24");
      expect(wan.gateway).to.equal("203.0.113.1");
      expect(wan.nameservers).to.eql(["1.1.1.1"]);
      expect(wan.dhcp).to.be.undefined;
      expect(_.get(config, ["routing", "global", "default", "viaIntf"])).to.equal("eth0");
    });

    it('should accept several dns servers for a static wan', () => {
      const config = op.expandProfile(adaptiveNetwork({
        type: "static", ip: "203.0.113.5", mask: "255.255.255.0", gateway: "203.0.113.1", dns: "1.1.1.1, 8.8.8.8"
      }), ports(2));
      expect(_.get(config, ["interface", "phy", "eth0", "nameservers"])).to.eql(["1.1.1.1", "8.8.8.8"]);
    });

    it('should put a pppoe wan on top of eth0 and route through ppp0', () => {
      const config = op.expandProfile(adaptiveNetwork({
        type: "pppoe", username: "user@isp", password: "secret"
      }), ports(3));
      // eth0 carries the ppp session, so it stays a plain port with no address and no wan meta
      expect(_.get(config, ["interface", "phy", "eth0"])).to.eql({enabled: true});
      const ppp = _.get(config, ["interface", "pppoe", "ppp0"]);
      expect(ppp.intf).to.equal("eth0");
      expect(ppp.username).to.equal("user@isp");
      expect(_.get(ppp, ["meta", "type"])).to.equal("wan");
      expect(_.get(config, ["routing", "global", "default", "viaIntf"])).to.equal("ppp0");
      expect(_.get(config, ["nat", "br0_ppp0"])).to.eql({in: "br0", out: "ppp0"});
      expect(_.get(config, ["nat", "br0_eth0"])).to.be.undefined;
    });

    it('should keep sshd reachable on both wan and lan', () => {
      const config = op.expandProfile(adaptiveNetwork(), ports(4));
      expect(_.get(config, ["sshd", "eth0", "enabled"])).to.be.true;
      expect(_.get(config, ["sshd", "br0", "enabled"])).to.be.true;
    });

    it('should drop icmp echo on the wan and allow it on the lan bridge', () => {
      const config = op.expandProfile(adaptiveNetwork(), ports(4));
      expect(_.get(config, ["icmp", "eth0", "echoRequest"])).to.be.false;
      expect(_.get(config, ["icmp", "br0", "echoRequest"])).to.be.true;
      const pppoeConfig = op.expandProfile(adaptiveNetwork({
        type: "pppoe", username: "user@isp", password: "secret"
      }), ports(4));
      expect(_.get(pppoeConfig, ["icmp", "ppp0", "echoRequest"])).to.be.false;
      expect(_.get(pppoeConfig, ["icmp", "eth0"])).to.be.undefined;
      expect(_.get(pppoeConfig, ["icmp", "br0", "echoRequest"])).to.be.true;
    });

    it('should produce a config that passes validateConfig', async () => {
      for (const wan of [{type: "dhcp"},
                         {type: "pppoe", username: "u", password: "p"},
                         {type: "static", ip: "203.0.113.5", mask: "255.255.255.0", gateway: "203.0.113.1", dns: "1.1.1.1"}]) {
        const errors = await ncm.validateConfig(op.expandProfile(adaptiveNetwork(wan), ports(5)));
        expect(errors).to.eql([]);
      }
    });

    it('should reject a profile it cannot build', () => {
      expect(() => op.expandProfile(adaptiveNetwork(), ["eth1", "eth2"])).to.throw(/eth0 is not present/);
      expect(() => op.expandProfile({profile: "whatever"}, ports(4))).to.throw(/unsupported network profile/);
      expect(() => op.expandProfile(adaptiveNetwork({type: "carrier-pigeon"}), ports(4))).to.throw(/unsupported wan type/);
      expect(() => op.expandProfile(adaptiveNetwork({type: "pppoe", username: "u"}), ports(4))).to.throw(/username and password/);
      expect(() => op.expandProfile(adaptiveNetwork({type: "static", ip: "203.0.113.5", mask: "255.255.255.0", gateway: "nope", dns: "1.1.1.1"}), ports(4))).to.throw(/gateway/);
      const badLan = adaptiveNetwork();
      badLan.lan.mask = "255.0.255.0";
      expect(() => op.expandProfile(badLan, ports(4))).to.throw(/lan mask/);
      const tinyLan = adaptiveNetwork();
      tinyLan.lan.mask = "255.255.255.252";
      expect(() => op.expandProfile(tinyLan, ports(4))).to.throw(/too small/);
    });
  });
});

describe('Test onboard config consumption', function() {
  this.timeout(30000);

  let origReadOnboardConfig, origIsOnboardConfigSupported, origGetPhyInterfaceNames;

  beforeEach(() => {
    origReadOnboardConfig = ncm.readOnboardConfig;
    origIsOnboardConfigSupported = platform.isOnboardConfigSupported;
    origGetPhyInterfaceNames = ncm.getPhyInterfaceNames;
    ncm.getPhyInterfaceNames = async () => ports(4);
  });

  afterEach(() => {
    ncm.readOnboardConfig = origReadOnboardConfig;
    platform.isOnboardConfigSupported = origIsOnboardConfigSupported;
    ncm.getPhyInterfaceNames = origGetPhyInterfaceNames;
  });

  describe('getDefaultConfig', () => {
    it('should expand an adaptive profile', async () => {
      platform.isOnboardConfigSupported = () => true;
      const network = adaptiveNetwork();
      ncm.readOnboardConfig = async () => ({parsed: {network}, raw: JSON.stringify({network}), path: "/tmp/nonexistent.json"});
      const config = await ncm.getDefaultConfig();
      expect(_.get(config, ["interface", "bridge", "br0", "intf"])).to.eql(["eth1", "eth2", "eth3"]);
    });

    it('should fall back to default setup when the profile cannot be expanded', async () => {
      platform.isOnboardConfigSupported = () => true;
      const network = adaptiveNetwork({type: "carrier-pigeon"});
      ncm.readOnboardConfig = async () => ({parsed: {network}, raw: JSON.stringify({network}), path: "/tmp/nonexistent.json"});
      const config = await ncm.getDefaultConfig();
      expect(config).to.eql(require('../../network/default_setup.json'));
    });
  });

  describe('consumeOnboardConfig', () => {
    // redis and saveConfig are fully stubbed, live box config is never touched
    const testFile = "/tmp/test-onboard-config.json";
    let origSaveConfig, origGetAsync, origSetAsync;
    let savedConfig, hashStore;

    const writeOnboard = async (network) => {
      const content = {network, license: {uuid: "test"}, provision: {ifmap: {eth0: "20:6d:31:51:04:c7"}}};
      await fsp.writeFile(testFile, JSON.stringify(content, null, 2));
    };

    beforeEach(async () => {
      savedConfig = null;
      hashStore = {};
      origSaveConfig = ncm.saveConfig;
      origGetAsync = rclient.getAsync;
      origSetAsync = rclient.setAsync;
      ncm.saveConfig = async (config) => { savedConfig = config; };
      rclient.getAsync = async (key) => key === "sysdb:onboardConfigHash" ? (hashStore[key] || null) : origGetAsync.call(rclient, key);
      rclient.setAsync = async (key, value) => { hashStore[key] = value; return "OK"; };
      await writeOnboard(adaptiveNetwork());
      platform.isOnboardConfigSupported = () => true;
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

    it('should consume once, leave the file untouched, then no-op', async () => {
      const before = await fsp.readFile(testFile, {encoding: "utf8"});
      const consumed = await ncm.consumeOnboardConfig();
      expect(consumed).to.be.true;
      // the expanded config becomes active, the file stays as the record of intent
      expect(_.get(savedConfig, ["interface", "phy", "eth0", "meta", "type"])).to.equal("wan");
      expect(_.get(savedConfig, ["interface", "bridge", "br0", "intf"])).to.eql(["eth1", "eth2", "eth3"]);
      expect(await fsp.readFile(testFile, {encoding: "utf8"})).to.equal(before);
      const consumedAgain = await ncm.consumeOnboardConfig();
      expect(consumedAgain).to.be.false;
    });

    it('should follow the port count of the box it runs on', async () => {
      ncm.getPhyInterfaceNames = async () => ports(10);
      await ncm.consumeOnboardConfig();
      expect(_.get(savedConfig, ["interface", "bridge", "br0", "intf"]).length).to.equal(9);
    });

    it('should still accept a full network config', async () => {
      await writeOnboard({
        interface: {
          phy: {eth0: {meta: {name: "WAN", type: "wan"}, enabled: true, dhcp: true}, eth1: {enabled: true}},
          bridge: {br0: {meta: {name: "LAN", type: "lan"}, ipv4: "10.10.0.1/24", intf: ["eth1"], enabled: true}}
        },
        routing: {global: {default: {viaIntf: "eth0"}}},
        nat: {br0_eth0: {in: "br0", out: "eth0"}}
      });
      const consumed = await ncm.consumeOnboardConfig();
      expect(consumed).to.be.true;
      expect(_.get(savedConfig, ["interface", "bridge", "br0", "intf"])).to.eql(["eth1"]);
    });

    it('should not consume when the profile cannot be expanded', async () => {
      await writeOnboard(adaptiveNetwork({type: "carrier-pigeon"}));
      const before = await fsp.readFile(testFile, {encoding: "utf8"});
      const consumed = await ncm.consumeOnboardConfig();
      expect(consumed).to.be.false;
      expect(savedConfig).to.be.null;
      expect(await fsp.readFile(testFile, {encoding: "utf8"})).to.equal(before);
      expect(hashStore).to.eql({});
    });
  });
});
