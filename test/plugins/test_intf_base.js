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

let chai = require('chai');
let expect = chai.expect;

const fs = require('fs');
const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter');
let log = require('../../util/logger.js')(__filename, 'info');
const routing = require('../../util/routing.js');

let InterfaceBasePlugin = require('../../plugins/interface/intf_base_plugin.js');

describe('Test ipv6 prefix renumbering', function(){
    const pdRecord = '/dev/shm/dhcpcd.pd_deprecated.eth9';
    const raRecord = '/dev/shm/dhcpcd.ra_deprecated.eth9';

    beforeEach(() => {
      this.plugin = new InterfaceBasePlugin("eth9");
      // an upstream /56 with 3000s left, plus an entry for an unrelated prefix
      fs.writeFileSync(pdRecord, '2001:db8:1::/56@3000,2001:db8:ff::/56@1200,');
      fs.writeFileSync(raRecord, '2001:db8:5::/64@900,');
    });

    afterEach(() => {
      for (const f of [pdRecord, raRecord])
        try { fs.unlinkSync(f); } catch (err) {}
    });

    it('should reduce an address to its prefix', async() => {
      expect(this.plugin._getIPv6PrefixCidr('2001:db8:1:2::1/64')).to.be.equal('2001:db8:1:2::/64');
      expect(this.plugin._getIPv6PrefixCidr('not an address')).to.be.equal(null);
    });

    it('should parse ip addr show output', async() => {
      const stdout = [
        '5: br0    inet6 2001:db8:aa::1/64 scope global \\       valid_lft forever preferred_lft forever',
        '5: br0    inet6 2001:db8:bb::1/64 scope global deprecated \\       valid_lft 7195sec preferred_lft 0sec',
        ''
      ].join('\n');

      expect(this.plugin._parseIPv6AddrShow(stdout)).to.be.eql([
        {addr: '2001:db8:aa::1/64', validLft: null},
        {addr: '2001:db8:bb::1/64', validLft: 7195}
      ]);
      expect(this.plugin._parseIPv6AddrShow('')).to.be.eql([]);
    });

    it('should pick the prefix that just went away', async() => {
      const live = new Set(['2001:db8:9:1::/64']);
      const picked = this.plugin._selectPrefixesToDeprecate(
        [{addr: '2001:db8:7:1::1/64'}, {addr: '2001:db8:9:1::1/64'}], [], live);
      expect(picked.map(p => p.prefix)).to.be.eql(['2001:db8:7:1::/64']);
      // lifetime is left for the caller to resolve from the upstream lease
      expect(picked[0].expiresAt).to.be.equal(undefined);
    });

    it('should carry an already deprecated prefix over a reapply that is not a renumbering', async() => {
      const live = new Set(['2001:db8:9:1::/64']);
      const picked = this.plugin._selectPrefixesToDeprecate(
        [{addr: '2001:db8:9:1::1/64'}],                       // nothing went away
        [{addr: '2001:db8:7:1::1/64', expiresAt: 2400}], live);
      expect(picked).to.be.eql([{addr: '2001:db8:7:1::1/64', prefix: '2001:db8:7:1::/64', expiresAt: 2400}]);
    });

    it('should keep the carried-over prefix alongside a new renumbering', async() => {
      const live = new Set(['2001:db8:a:1::/64']);
      const picked = this.plugin._selectPrefixesToDeprecate(
        [{addr: '2001:db8:9:1::1/64'}],                       // 9 just went away
        [{addr: '2001:db8:7:1::1/64', expiresAt: 2400}], live);  // 7 was already deprecated
      expect(picked).to.be.eql([
        {addr: '2001:db8:9:1::1/64', prefix: '2001:db8:9:1::/64'},
        {addr: '2001:db8:7:1::1/64', prefix: '2001:db8:7:1::/64', expiresAt: 2400}
      ]);
    });

    it('should drop a carried-over prefix that is live again', async() => {
      const live = new Set(['2001:db8:7:1::/64']);
      const picked = this.plugin._selectPrefixesToDeprecate(
        [{addr: '2001:db8:7:1::1/64'}], [{addr: '2001:db8:7:1::1/64', expiresAt: 2400}], live);
      expect(picked).to.be.eql([]);
    });

    it('should pick nothing when there is nothing to deprecate', async() => {
      expect(this.plugin._selectPrefixesToDeprecate([], [], new Set())).to.be.eql([]);
      expect(this.plugin._selectPrefixesToDeprecate(null, null, new Set())).to.be.eql([]);
    });

    it('should give a statically configured prefix the full ceiling', async() => {
      this.plugin.configure({ipv6: '2001:db8:1:2::1/64'});
      expect(await this.plugin._getDeprecationLifetime('2001:db8:1:2::/64')).to.be.equal(7200);
    });

    it('should use what is left of the upstream lease', async() => {
      this.plugin.configure({ipv6DelegateFrom: 'eth9'});
      expect(await this.plugin._getDeprecationLifetime('2001:db8:1:2::/64')).to.be.equal(3000);
    });

    it('should cap the upstream lease at the 2 hour ceiling', async() => {
      this.plugin.configure({ipv6DelegateFrom: 'eth9'});
      fs.writeFileSync(pdRecord, '2001:db8:1::/56@99999,');
      expect(await this.plugin._getDeprecationLifetime('2001:db8:1:2::/64')).to.be.equal(7200);
    });

    it('should report zero when the upstream prefix is already gone', async() => {
      this.plugin.configure({ipv6DelegateFrom: 'eth9'});
      fs.writeFileSync(pdRecord, '2001:db8:1::/56@0,');
      expect(await this.plugin._getDeprecationLifetime('2001:db8:1:2::/64')).to.be.equal(0);
    });

    it('should treat an unparseable record as unknown, not as expired', async() => {
      this.plugin.configure({ipv6DelegateFrom: 'eth9'});
      fs.writeFileSync(pdRecord, '2001:db8:1::/56@notanumber,');
      expect(await this.plugin._getDeprecationLifetime('2001:db8:1:2::/64')).to.be.equal(7200);
    });

    it('should treat an empty lifetime as unknown, not as expired', async() => {
      this.plugin.configure({ipv6DelegateFrom: 'eth9'});
      // Number("") is 0, which would read as "the upstream prefix is already gone"
      fs.writeFileSync(pdRecord, '2001:db8:1::/56@,');
      expect(await this.plugin._getDeprecationLifetime('2001:db8:1:2::/64')).to.be.equal(7200);
    });

    it('should ignore records for other prefixes', async() => {
      this.plugin.configure({ipv6DelegateFrom: 'eth9'});
      expect(await this.plugin._getDeprecationLifetime('2001:db8:99:1::/64')).to.be.equal(7200);
    });

    it('should fall back to the ceiling when there is no record at all', async() => {
      this.plugin.configure({ipv6DelegateFrom: 'eth9'});
      fs.unlinkSync(pdRecord);
      expect(await this.plugin._getDeprecationLifetime('2001:db8:1:2::/64')).to.be.equal(7200);
    });

    it('should read the RA record for a passthrough network', async() => {
      this.plugin.configure({ipv6PassthroughFrom: 'eth9'});
      expect(await this.plugin._getDeprecationLifetime('2001:db8:5::/64')).to.be.equal(900);
    });

    it('should still advertise a withdrawal when the upstream lease is already expired', async() => {
      expect(this.plugin._clampDeprecationLifetime(0)).to.be.equal(120);
      expect(this.plugin._clampDeprecationLifetime(-5)).to.be.equal(120);
      expect(this.plugin._clampDeprecationLifetime(undefined)).to.be.equal(120);
    });

    it('should also floor a lifetime too short to survive dnsmasq conf regen + restart', async() => {
      expect(this.plugin._clampDeprecationLifetime(2)).to.be.equal(120);
      expect(this.plugin._clampDeprecationLifetime(119)).to.be.equal(120);
    });

    it('should leave a real remaining lifetime untouched', async() => {
      expect(this.plugin._clampDeprecationLifetime(900)).to.be.equal(900);
      expect(this.plugin._clampDeprecationLifetime(120)).to.be.equal(120);
    });

    it('should age a deprecation record by how long it has sat unread', async() => {
      this.plugin.configure({ipv6DelegateFrom: 'eth9'});
      const writtenAt = new Date((Date.now() / 1000 - 400) * 1000);
      fs.utimesSync(pdRecord, writtenAt, writtenAt);   // record was written 400s ago, not now
      expect(await this.plugin._getDeprecationLifetime('2001:db8:1:2::/64')).to.be.equal(2600); // 3000 - 400
    });

    it('should never age a deprecation record below zero', async() => {
      this.plugin.configure({ipv6DelegateFrom: 'eth9'});
      const writtenAt = new Date((Date.now() / 1000 - 9999) * 1000);
      fs.utimesSync(pdRecord, writtenAt, writtenAt);
      expect(await this.plugin._getDeprecationLifetime('2001:db8:1:2::/64')).to.be.equal(0);
    });
});

describe('Test interface base dhcp6', function(){
    this.timeout(30000);

    before(async () => {
        this.plugin = new InterfaceBasePlugin("eth0");
        this.plugin.configure({dhcp6:{}});
        await exec(`cat /dev/null | sudo tee ${r.getRuntimeFolder()}/dhcpcd.duid`).catch((err) => {});
    });

    after((done) => {
      done();
    });

    it('should generate duid', async()=> {
      let newDuid;
      let duid = await this.plugin._getDuid();
      log.debug("current duid", duid);

      newDuid = await this.plugin._genDuid('DUID-LLT');
      duid = await this.plugin._getDuid();
      log.debug('new DUID-LLT', duid);
      expect(duid).to.be.eql(newDuid);
      expect(duid).to.contains('00:01:');

      newDuid = await this.plugin._genDuid('DUID-LL');
      duid = await this.plugin._getDuid();
      log.debug('new DUID-LL', duid);
      expect(duid).to.be.eql(newDuid);
      expect(duid).to.contains('00:03:');

      newDuid = await this.plugin._genDuid('DUID-UUID');
      duid = await this.plugin._getDuid();
      log.debug('new DUID-UUID', duid);
      expect(duid).to.be.eql(newDuid);
      expect(duid).to.contains('00:04:');
    });

    it('should gen duid uuid', async() => {
      const t1 = await this.plugin._genDuidUuid();
      const t2 = await this.plugin._genDuidUuid();
      const duid = await fs.readFileAsync(`${r.getRuntimeFolder()}/dhcpcd-${this.plugin.name}.duid_uuid`, {encoding: "utf8"}).then((content) => content.trim()).catch((err) => null);
      log.debug("duid uuid generated", duid);
      expect(t1).to.be.equal(duid);
      expect(t2).to.be.equal(duid);
    });

    it('should reset duid', async() => {
      await this.plugin._resetDuid();
      let duidType = await this.plugin._getDuidType(await this.plugin._getDuid());
      const arch = await exec("uname -m", {encoding: 'utf8'}).then(result => result.stdout.trim()).catch((err) => {}); switch (arch) {
        case 'x86_64':
          expect(duidType).to.equal('DUID-UUID');
          break;
        case 'aarch64':
          expect(duidType).to.equal('DUID-LLT');
          break;
      }
    });

    it('should get duid type', async() => {
      expect(this.plugin._getDuidType('00:01:00:01:66:97:49:e4:20:6d:31:01:2b:43')).to.be.equal('DUID-LLT');
      expect(this.plugin._getDuidType('00:03:00:01:20:6d:31:01:2b:43')).to.be.equal('DUID-LL');
      expect(this.plugin._getDuidType('00:04:7e:89:20:22:89:15:45:b8:ac:05:3c:68:2b:08:04:8f')).to.be.equal('DUID-UUID');
    });

    it('should get link speed', async() => {
      const speed = await this.plugin.linkSpeed();
      log.debug(this.plugin.name,"speed:", speed);
      expect(isNaN(speed)).to.be.equal(false);
    });

});


  describe('Test interface base dns', function(){
    this.timeout(30000);

    before(async () => {
        this.plugin = new InterfaceBasePlugin("eth0");
        this.plugin.configure({dhcp6:{}, dhcp:true});
    });

    after(async () => {
    });

    it('should config dns6', async() => {
      await this.plugin.configure({dns6Servers: ["2606:4700:4700::1111", "2001:4860:4860::8888"], dhcp:false});
      await this.plugin.applyDnsSettings();
      log.debug("dns6", await this.plugin.getOrigDNS6Nameservers());
      log.debug("resolv.conf\n", await exec("cat /etc/resolv.conf").then(ret => ret.stdout.trim()).catch( (err) => {log.error(err.message)}));
    });

    it('should dhcp dns6', async() => {
      await this.plugin.configure({dhcp:true});
      await this.plugin.applyDnsSettings();
      log.debug("dns6", await this.plugin.getOrigDNS6Nameservers());
      log.debug("resolv.conf\n", await exec("cat /etc/resolv.conf").then(ret => ret.stdout.trim()).catch( (err) => {log.error(err.message)}));
    });

    it.skip('should get dns result', async() => {
      const config = await exec('redis-cli -n 1 get sysdb:networkConfig | jq -c .interface.phy.eth0').then(r => r.stdout.trim()).catch((err) => {return '{dhcp:true, extra:{}}'}) ;
      await this.plugin.configure(JSON.parse(config));
      const ip6s = await this.plugin.getIPv6Addresses();
      const dns6 = await this.plugin.getOrigDNS6Nameservers();

      const result = await this.plugin._getDNSResult("archlinux.org", ip6s.pop().split('/')[0], dns6[0], false, 6);
      log.debug("dig dns result:", result);
      // expect(result).to.be.equal("95.217.163.246");
    });

    it('should run dns test', async() => {
      const results = await this.plugin.getDNSResult("archlinux.org", false);
      log.debug("dig dns result:", results);
      // expect(result).to.be.equal(["95.217.163.246","95.217.163.246"]);
    });

    it('should preserve link-local ipv6 dns in the general helper', async() => {
      const plugin = new InterfaceBasePlugin("wlan0");
      plugin.configure({ dhcp: true, dhcp6: {} });

      const originalGetDNSNameservers = plugin.getDNSNameservers;
      plugin.getDNSNameservers = async () => ([
        'fe80::6057:c8ff:fe51:5764%wlan0',
        '2606:4700:4700::1111',
        'not-an-ip'
      ]);

      try {
        expect(await plugin.getDns6Nameservers()).to.deep.equal([
          'fe80::6057:c8ff:fe51:5764%wlan0',
          '2606:4700:4700::1111'
        ]);
      } finally {
        plugin.getDNSNameservers = originalGetDNSNameservers;
      }
    });

    it('should ignore scoped link-local ipv6 dns when updating dns routes', async() => {
      const plugin = new InterfaceBasePlugin("wlan0");
      plugin.configure({ dhcp: true, dhcp6: {} });

      const originalRemoveOldRouteForDNS = plugin._removeOldRouteForDNS;
      const originalUpdateDnsRouteCache = plugin._updateDnsRouteCache;
      const originalGetDns4Nameservers = plugin.getDns4Nameservers;
      const originalGetRoutableDns6Nameservers = plugin.getRoutableDns6Nameservers;
      const originalGetInterfaceGWIP = routing.getInterfaceGWIP;
      const originalAddRouteToTable = routing.addRouteToTable;

      const routeCalls = [];
      plugin._removeOldRouteForDNS = async () => {};
      plugin._updateDnsRouteCache = () => {};
      plugin.getDns4Nameservers = async () => ['172.20.10.1'];
      plugin.getRoutableDns6Nameservers = async () => ['2606:4700:4700::1111'];
      routing.getInterfaceGWIP = async (intf, af) => {
        expect(intf).to.equal('wlan0');
        return af === 4 ? '172.20.10.254' : 'fe80::1';
      };
      routing.addRouteToTable = async (...args) => {
        routeCalls.push(args);
      };

      try {
        await plugin.updateRouteForDNS();
      } finally {
        plugin._removeOldRouteForDNS = originalRemoveOldRouteForDNS;
        plugin._updateDnsRouteCache = originalUpdateDnsRouteCache;
        plugin.getDns4Nameservers = originalGetDns4Nameservers;
        plugin.getRoutableDns6Nameservers = originalGetRoutableDns6Nameservers;
        routing.getInterfaceGWIP = originalGetInterfaceGWIP;
        routing.addRouteToTable = originalAddRouteToTable;
      }

      expect(routeCalls).to.deep.equal([
        ['172.20.10.1', '172.20.10.254', 'wlan0', 'wlan0_default', null, 4, true],
        ['2606:4700:4700::1111', 'fe80::1', 'wlan0', 'wlan0_default', null, 6, true]
      ]);
    });
  });

  describe('Test interface base mcproxy config for ipv6PassthroughFrom', function(){
    it('should derive a distinct routing table number per LAN bridge', () => {
      expect(new InterfaceBasePlugin("br0")._mcproxyTableNumber()).to.equal(1);
      expect(new InterfaceBasePlugin("br1")._mcproxyTableNumber()).to.equal(2);
      expect(new InterfaceBasePlugin("br2")._mcproxyTableNumber()).to.equal(3);
      // an interface name with no trailing digit can't be mapped to a table number
      expect(new InterfaceBasePlugin("eth")._mcproxyTableNumber()).to.be.null;
      // non-bridge interfaces are rejected even with a trailing digit, so they can never
      // collide with an unrelated bridge's table number (e.g. eth0 vs br0)
      expect(new InterfaceBasePlugin("eth0")._mcproxyTableNumber()).to.be.null;
    });

    it('should derive a distinct table number per bond and per VLAN-on-bond, even when the VLAN tag repeats across bonds', () => {
      const bond0vlan100 = new InterfaceBasePlugin("bond0.100")._mcproxyTableNumber();
      const bond1vlan100 = new InterfaceBasePlugin("bond1.100")._mcproxyTableNumber();
      expect(bond0vlan100).to.not.equal(bond1vlan100);
      expect(bond0vlan100).to.equal(2000100);
      expect(bond1vlan100).to.equal(2010100);

      expect(new InterfaceBasePlugin("bond0")._mcproxyTableNumber()).to.equal(1000000);
      expect(new InterfaceBasePlugin("bond1")._mcproxyTableNumber()).to.equal(1000001);

      // plain bonds must not collide with VLANs-on-bonds either
      expect(new InterfaceBasePlugin("bond0")._mcproxyTableNumber())
        .to.not.equal(new InterfaceBasePlugin("bond0.100")._mcproxyTableNumber());
    });

    it('should write a pinstance config bound to the assigned table', async () => {
      const plugin = new InterfaceBasePlugin("br0");
      plugin.configure({});
      const confDir = `${r.getUserConfigFolder()}/mcproxy`;
      const confPath = `${confDir}/br0.conf`;
      await fs.promises.mkdir(confDir, { recursive: true });
      await plugin._writeMcproxyConfigFile("eth1", "br0", 1);
      const content = await fs.promises.readFile(confPath, { encoding: "utf8" });
      expect(content).to.equal("protocol MLDv2;\npinstance \"br0\"(1): \"eth1\" ==> \"br0\";\n");
      await fs.promises.unlink(confPath).catch(() => {});
      await fs.promises.rmdir(confDir).catch(() => {});
    });
  });
