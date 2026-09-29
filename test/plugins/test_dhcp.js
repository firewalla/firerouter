/*    Copyright 2016-2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
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

const fs = require('fs');
const os = require('os');
const path = require('path');

const stub = require('./stub_exec.js');
const DHCPPlugin = stub.load(require.resolve('../../plugins/dhcp/dhcp_plugin.js'));
let log = require('../../util/logger.js')(__filename, 'info');

// writeDHCPConfFile concatenates its values into a line-oriented dnsmasq conf file that
// etc/dnsmasq.dhcp.default.conf pulls in wholesale with conf-dir, and
// firerouter_dhcp.template.service is User=root with no dhcp-scriptuser set anywhere. A line break
// in one of those values stops being dhcp option data and becomes a daemon setting of its own.
describe('Test dhcp plugin configuration', function(){
  this.timeout(30000);

  const confPath = path.join(os.tmpdir(), `firerouter_test_dhcp_${process.pid}.conf`);

  const write = async (extraOptions, overrides = {}) => {
    await fs.unlinkAsync(confPath).catch(() => {});
    const plugin = new DHCPPlugin("eth0");
    plugin._getConfFilePath = () => confPath;
    await plugin.writeDHCPConfFile(
      overrides.iface || "eth0",
      overrides.tags || [],
      "192.168.10.100", "192.168.10.150", "255.255.255.0", overrides.lease || "86400",
      overrides.gateway || "192.168.10.1",
      overrides.nameservers || ["192.168.10.1"],
      overrides.searchDomains || [],
      extraOptions
    ).catch(() => {});
    return await fs.readFileAsync(confPath, {encoding: "utf8"}).catch(() => null);
  };

  after(async () => {
    await fs.unlinkAsync(confPath).catch(() => {});
  });

  // The writer itself does not screen its input. `ncm.validateConfig` is what keeps a control
  // character out of these fields, and what restricts an extraOptions key to a DHCP option code -
  // both covered in test/core/test_ncm.js. What is worth pinning here is the shape of what the
  // writer emits, since every line of it is a directive dnsmasq will act on.
  it('should generate ordinary dhcp options', async() => {
    const content = await write({"15": "lan.example", "252": {value: "http://wpad.example/wpad.dat", force: true}},
      {tags: ["tag1"], searchDomains: ["lan.example"]});
    log.debug("dhcp conf\n", content);
    expect(content).to.not.be.null;
    expect(content).to.contain("dhcp-range=tag:eth0,tag:tag1,192.168.10.100,192.168.10.150,255.255.255.0,86400");
    expect(content).to.contain("dhcp-option=tag:eth0,tag:tag1,3,192.168.10.1");
    expect(content).to.contain("dhcp-option=tag:eth0,tag:tag1,15,lan.example");
    expect(content).to.contain("dhcp-option-force=tag:eth0,tag:tag1,252,http://wpad.example/wpad.dat");
    // nothing in the generated file may be a daemon setting rather than dhcp option data
    for (const line of content.split("\n"))
      expect(line, `unexpected directive ${line}`).to.match(/^(dhcp-range|dhcp-option|dhcp-option-force|dhcp-boot)=/);
  });
});
