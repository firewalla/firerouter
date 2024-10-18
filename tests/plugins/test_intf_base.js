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

let InterfaceBasePlugin = require('../../plugins/interface/intf_base_plugin.js');

describe('Test interface base dhcp6', function(){
    this.timeout(30000);

    before((done) => (
      async() => {
        this.plugin = new InterfaceBasePlugin("eth0");
        this.plugin.configure({dhcp6:{}});
        await exec(`cat /dev/null | sudo tee ${r.getRuntimeFolder()}/dhcpcd.duid`).catch((err) => {});
        done();
      })()
    );

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
      const duuuid = await fs.readFileAsync(`${r.getRuntimeFolder()}/dhcpcd.duid_uuid`, {encoding: "utf8"}).then((content) => content.trim()).catch((err) => null);
      log.debug("duid uuid generated", duuuid);
      expect(t1).to.be.equal(duuuid);
      expect(t2).to.be.equal(duuuid);
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
  });


  describe('Test interface base dns', function(){
    this.timeout(30000);

    before((done) => (
      async() => {
        this.plugin = new InterfaceBasePlugin("eth0");
        this.plugin.configure({dhcp6:{}, dhcp:true});
        done();
      })()
    );

    after((done) => (
      async() => {
        done();
      })()
    );

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
  });

