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

let chai = require('chai');
let expect = chai.expect;

const uuid = require('uuid');
let util = require('../../util/util.js');
let log = require('../../util/logger.js')(__filename, 'info');

describe('Test util', function(){
  this.timeout(30000);

  before(async () => {
  });

  after(async () => {
  });


  it('should generate uuid', async()=> {
    const u = util.generateUUID();
    log.debug("generate uuid", u);
    expect(u.length).to.be.equal(32);
  });

  describe('getHexStrArray', function(){
    // callers join the array with no separator, so a byte that renders as one digit
    // desynchronizes every byte after it
    it('should emit two digits for every byte', async()=> {
      for (const str of ["MyWiFi", "café", "a\nb", "", "Guest WiFi"]) {
        const arr = util.getHexStrArray(str);
        const bytes = Buffer.from(str, 'utf8').length;
        expect(arr.length, `byte count of ${JSON.stringify(str)}`).to.be.equal(bytes);
        for (const hex of arr)
          expect(hex.length, `width of ${hex} in ${JSON.stringify(str)}`).to.be.equal(2);
      }
    });

    it('should round trip through a joined hex string', async()=> {
      for (const str of ["MyWiFi", "café", "a\nb", ""]) {
        const joined = util.getHexStrArray(str).join("");
        log.debug("hex of", JSON.stringify(str), joined);
        expect(Buffer.from(joined, 'hex').toString('utf8')).to.be.equal(str);
      }
    });

    it('should pad a control character rather than shortening it', async()=> {
      // 0x0a used to render as "a", shifting the decoding of everything after it
      expect(util.getHexStrArray("a\nb").join("")).to.be.equal("610a62");
    });
  });

  describe('isValidUUID', function(){
    it('should accept canonical uuids', async()=> {
      expect(util.isValidUUID(uuid.v4())).to.be.true;
      expect(util.isValidUUID("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).to.be.true;
    });

    it('should reject a malformed uuid', async()=> {
      expect(util.isValidUUID("x; sudo id > /tmp/pwn; #")).to.be.false;
      expect(util.isValidUUID("")).to.be.false;
      // generateUUID produces a dashless 32 char id, which is not a uuid and is used elsewhere
      expect(util.isValidUUID("0123456789abcdef0123456789abcdef")).to.be.false;
    });

    it('should return false rather than throw on a non string', async()=> {
      // validator.isUUID throws on non strings, callers pass whatever arrived in the config
      for (const input of [null, undefined, 12345, {}, []])
        expect(util.isValidUUID(input), `input ${JSON.stringify(input)}`).to.be.false;
    });
  });

  describe('isValidDNSName', function(){
    it('should accept hostnames as dig prints them', async()=> {
      for (const name of ["example.com", "example.com.", "sub.example.com.", "a", "a.b",
                          "my-host.example.com", "ns1.cloudflare.com.", "xn--80ak6aa92e.com"])
        expect(util.isValidDNSName(name), `expected ${name} to be accepted`).to.be.true;
    });

    it('should reject a name that would read as a dig option', async()=> {
      // execFile keeps these away from a shell, but dig still parses a leading '-' as an option
      for (const name of ["-f", "-felection", "-x", "--version", "-b1.2.3.4"])
        expect(util.isValidDNSName(name), `expected ${name} to be rejected`).to.be.false;
    });

    it('should require every label to start and end alphanumeric', async()=> {
      for (const name of ["-a.com", "a-.com", "foo.-bar.com", "foo.bar-.com", ".com", "a..b"])
        expect(util.isValidDNSName(name), `expected ${name} to be rejected`).to.be.false;
    });

    it('should reject shell metacharacters and oversized names', async()=> {
      for (const name of ["a`id`b.com", "a;id.com", "a|id.com", "a b.com", "a$(id).com", "a/b.com"])
        expect(util.isValidDNSName(name), `expected ${JSON.stringify(name)} to be rejected`).to.be.false;
      expect(util.isValidDNSName("a".repeat(64) + ".com"), 'label over 63 chars').to.be.false;
      expect(util.isValidDNSName(("a".repeat(60) + ".").repeat(5)), 'name over 253 chars').to.be.false;
    });

    it('should return false rather than throw on non strings', async()=> {
      for (const input of [null, undefined, "", 12345, {}, []])
        expect(util.isValidDNSName(input), `input ${JSON.stringify(input)}`).to.be.false;
    });
  });

  describe('toBoundedInt', function(){
    it('should accept an in-range integer as a number or a string', async()=> {
      // the same config value arrives typed differently depending on which producer wrote it
      expect(util.toBoundedInt(51820, 1, 65535)).to.be.equal(51820);
      expect(util.toBoundedInt("51820", 1, 65535)).to.be.equal(51820);
      expect(util.toBoundedInt(" 51820 ", 1, 65535)).to.be.equal(51820);
      expect(util.toBoundedInt(1, 1, 65535)).to.be.equal(1);
      expect(util.toBoundedInt(65535, 1, 65535)).to.be.equal(65535);
    });

    it('should reject values outside the bounds', async()=> {
      expect(util.toBoundedInt(0, 1, 65535)).to.be.null;
      expect(util.toBoundedInt(65536, 1, 65535)).to.be.null;
      expect(util.toBoundedInt(-1, 1, 65535)).to.be.null;
      expect(util.toBoundedInt("70000", 1, 65535)).to.be.null;
    });

    it('should reject anything that is not a whole number', async()=> {
      // a bare Number() would let all of these through
      expect(util.toBoundedInt(1.5, 1, 65535)).to.be.null;
      expect(util.toBoundedInt("Infinity", 1)).to.be.null;
      expect(util.toBoundedInt(Infinity, 1)).to.be.null;
      expect(util.toBoundedInt(NaN, 1)).to.be.null;
      expect(util.toBoundedInt("x; touch /tmp/pwn; #", 1, 65535)).to.be.null;
    });

    it('should reject empty and non scalar input rather than coercing it', async()=> {
      // "" and [] both coerce to 0, true coerces to 1, none of them are a config value
      for (const input of ["", "   ", null, undefined, true, false, {}, [], [5]])
        expect(util.toBoundedInt(input, 1, 65535), `input ${JSON.stringify(input)}`).to.be.null;
    });

    it('should default the bounds when they are omitted', async()=> {
      expect(util.toBoundedInt("42")).to.be.equal(42);
      expect(util.toBoundedInt(-42)).to.be.equal(-42);
      // a lower bound alone is enough for the positive-integer cases
      expect(util.toBoundedInt(-42, 1)).to.be.null;
      expect(util.toBoundedInt("2048", 1)).to.be.equal(2048);
    });
  });

  describe('findControlChar', function(){
    it('should find a line break in a value and report its path', async()=> {
      expect(util.findControlChar({dhcp: {eth0: {extraOptions: {"15": "a\ndhcp-script=/tmp/pwn.sh"}}}}))
        .to.be.equal("dhcp.eth0.extraOptions.15");
      expect(util.findControlChar({interface: {pppoe: {ppp0: {mru: "1492\nplugin /tmp/pwn.so"}}}}))
        .to.be.equal("interface.pppoe.ppp0.mru");
    });

    it('should find a line break in a key', async()=> {
      // hostapd_plugin and wlan_intf_plugin both emit `key=value` lines from config keys
      expect(util.findControlChar({hostapd: {wlan0: {params: {"channel\ndhcp-script=/tmp/pwn.sh": 6}}}}))
        .to.be.equal("hostapd.wlan0.params.channel\\ndhcp-script=/tmp/pwn.sh");
    });

    it('should walk arrays and report the index', async()=> {
      expect(util.findControlChar({interface: {phy: {eth0: {nameservers: ["1.1.1.1", "8.8.8.8\nserver=evil"]}}}}))
        .to.be.equal("interface.phy.eth0.nameservers[1]");
    });

    it('should catch every control character, not only CR and LF', async()=> {
      for (const ch of ["\x00", "\x07", "\x09", "\x0b", "\x1b", "\x1f", "\x7f"])
        expect(util.findControlChar({a: {b: `x${ch}y`}}), `char ${JSON.stringify(ch)}`).to.be.equal("a.b");
    });

    it('should accept an ordinary config, including non ascii names', async()=> {
      // real boxes carry CJK and emoji in the display name fields, those must keep working
      expect(util.findControlChar({
        interface: {phy: {eth0: {ipv4: "192.168.1.1/24", meta: {name: "办公室 🏢", type: "lan"}}}},
        dhcp: {eth0: {range: {from: "192.168.1.100", to: "192.168.1.200"}, lease: 86400}},
        apc: {assets: {"20:6D:31:AF:00:51": {sysConfig: {name: "二楼"}}}}
      })).to.be.null;
    });

    it('should skip the ssid, the one field where an arbitrary byte is legal', async()=> {
      // 802.11 makes the ssid an opaque octet string, and in client mode the box has to be able to
      // join whatever the AP broadcasts
      expect(util.findControlChar({hostapd: {wlan0: {params: {ssid: "a\nb"}}}})).to.be.null;
      expect(util.findControlChar({interface: {wlan: {wlan0: {wpaSupplicant: {networks: [{ssid: "a\nb"}]}}}}})).to.be.null;
    });

    it('should reject a control character in every other wifi credential', async()=> {
      // being hex encoded downstream makes these harmless, not meaningful: 802.11i bounds the
      // ascii passphrase to characters 32 to 126, a psk is 64 hex digits, phase2 is directive syntax
      for (const key of ["password", "psk", "wpa_passphrase", "sae_password", "wep_key0",
                         "identity", "phase2", "anonymous_identity", "phase1", "private_key_passwd"])
        expect(util.findControlChar({interface: {wlan: {wlan0: {wpaSupplicant: {networks: [{[key]: "a\nb"}]}}}}}),
          `key ${key}`).to.be.equal(`interface.wlan.wlan0.wpaSupplicant.networks[0].${key}`);
    });

    it('should reject an apc wifi passphrase the same way as a hostapd one', async()=> {
      // apc.profile.<uuid>.key is an AP passphrase; it must not be treated differently from
      // hostapd.<intf>.params.wpa_passphrase just because it lives in another subtree
      expect(util.findControlChar({apc: {profile: {"p1": {ssid: "net", key: "pass\nx"}}}}))
        .to.be.equal("apc.profile.p1.key");
      expect(util.findControlChar({hostapd: {wlan0: {params: {wpa_passphrase: "pass\nx"}}}}))
        .to.be.equal("hostapd.wlan0.params.wpa_passphrase");
    });

    it('should not let an exempt key hide a subtree', async()=> {
      // the exemption is on an encoded string, anything below such a key is still walked
      expect(util.findControlChar({hostapd: {wlan0: {params: {ssid: {value: "a\nb"}}}}}))
        .to.be.equal("hostapd.wlan0.params.ssid.value");
    });

    it('should tolerate non string leaves and empty input', async()=> {
      for (const input of [null, undefined, {}, [], 42, true, {a: 1, b: null, c: [true, 2]}])
        expect(util.findControlChar(input), `input ${JSON.stringify(input)}`).to.be.null;
    });
  });

  describe('lastLine', function(){
    it('should behave like tail -n 1', async()=> {
      expect(util.lastLine("2606:4700::1111\n1.1.1.1\n")).to.be.equal("1.1.1.1");
      expect(util.lastLine("1.1.1.1")).to.be.equal("1.1.1.1");
      expect(util.lastLine("  a  \n  b  \n")).to.be.equal("b");
    });

    it('should tolerate empty output', async()=> {
      expect(util.lastLine("")).to.be.equal("");
      expect(util.lastLine(null)).to.be.equal("");
      expect(util.lastLine(undefined)).to.be.equal("");
    });
  });

});
