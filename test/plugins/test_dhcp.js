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
const pl = require('../../plugins/plugin_loader.js');
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

describe('Test dhcp plugin apply', function(){
  this.timeout(30000);

  const confPath = path.join(os.tmpdir(), `firerouter_test_dhcp_apply_${process.pid}.conf`);
  const range = {from: "192.168.10.100", to: "192.168.10.150"};
  const origGetPluginInstance = pl.getPluginInstance;
  let ifaces;
  let restarts;

  const build = (name, config = {range, subnetMask: "255.255.255.0", lease: 86400}) => {
    const plugin = stub.build(DHCPPlugin, name, config);
    plugin._getConfFilePath = () => confPath;
    plugin._restartService = () => { restarts++; };
    return plugin;
  };
  const read = () => fs.readFileAsync(confPath, {encoding: "utf8"}).catch(() => null);

  beforeEach(async () => {
    ifaces = {};
    restarts = 0;
    pl.getPluginInstance = (category, name) => category === "interface" ? ifaces[name] : null;
    await fs.unlinkAsync(confPath).catch(() => {});
  });

  afterEach(async () => {
    pl.getPluginInstance = origGetPluginInstance;
    await fs.unlinkAsync(confPath).catch(() => {});
  });

  it('should subscribe to the interface, write its range and restart dhcp', async() => {
    ifaces.br1 = stub.fakeInterface();
    const plugin = build("br1");
    await plugin.apply();
    expect(ifaces.br1.subscribers).to.deep.equal([plugin]);
    expect(await read()).to.contain("dhcp-range=tag:br1,192.168.10.100,192.168.10.150,255.255.255.0,86400");
    expect(restarts).to.equal(1);
  });

  it('should tag a virtual interface by its parent but look it up by its own name', async() => {
    ifaces["br0:0"] = stub.fakeInterface();
    const plugin = build("br0:0");
    await plugin.apply();
    expect(ifaces["br0:0"].subscribers).to.deep.equal([plugin]);
    expect(await read()).to.contain("dhcp-range=tag:br0,");
    expect(await read()).to.not.contain("tag:br0:0");
  });

  it('should write nothing and schedule no restart while the interface is not present', async() => {
    ifaces.br1 = stub.fakeInterface({isInterfacePresent: async () => false});
    const plugin = build("br1");
    await plugin.apply();
    // still subscribed, so the plugin is applied again once the interface shows up
    expect(ifaces.br1.subscribers).to.deep.equal([plugin]);
    expect(await read()).to.be.null;
    expect(restarts).to.equal(0);
  });

  it('should fail without an interface plugin and write nothing', async() => {
    const plugin = build("br1");
    let thrown = null;
    await plugin.apply().catch((err) => { thrown = err; });
    expect(thrown).to.equal("Interface plugin br1 is not found");
    expect(await read()).to.be.null;
    expect(restarts).to.equal(0);
  });

  describe('relay mode', function(){
    const relayConfig = (servers) => ({relay: {servers}});
    const withAddress = (addresses) => stub.fakeInterface({getIPv4Addresses: async () => addresses});

    it('should write one dhcp-relay line for a server, from the address of the network', async() => {
      ifaces.br1 = withAddress(["192.168.10.1/24"]);
      await build("br1", relayConfig(["10.20.0.5"])).apply();
      expect(await read()).to.equal("dhcp-relay=192.168.10.1,10.20.0.5");
      expect(restarts).to.equal(1);
    });

    it('should write one line per server', async() => {
      ifaces.br1 = withAddress(["192.168.10.1/24"]);
      await build("br1", relayConfig(["10.20.0.5", "10.20.0.6"])).apply();
      const content = await read();
      expect(content.split("\n")).to.deep.equal(["dhcp-relay=192.168.10.1,10.20.0.5", "dhcp-relay=192.168.10.1,10.20.0.6"]);
      // dnsmasq must not be handed a range or any other directive for a relayed network
      for (const line of content.split("\n"))
        expect(line, `unexpected directive ${line}`).to.match(/^dhcp-relay=/);
    });

    it('should write only the relay line whatever local server fields the entry carries', async() => {
      ifaces.br1 = withAddress(["192.168.10.1/24"]);
      const full = {range, subnetMask: "255.255.255.0", lease: 86400, gateway: "192.168.10.1", nameservers: ["192.168.10.1"],
        searchDomain: [".lan"], extraOptions: {"15": "lan.example"}, tags: ["grp1"]};
      const garbage = Object.assign({}, full, {range: {from: "x", to: "y"}});
      for (const local of [full, garbage, {range: {}}, {range: null}]) {
        await build("br1", Object.assign({relay: {servers: ["10.20.0.5"]}}, local)).apply();
        const content = await read();
        expect(content, JSON.stringify(local)).to.equal("dhcp-relay=192.168.10.1,10.20.0.5");
        expect(content).to.not.match(/dhcp-range|dhcp-option/);
      }
    });

    it('should take the address as it is when it carries no prefix length', async() => {
      ifaces.br1 = withAddress(["192.168.10.1"]);
      await build("br1", relayConfig(["10.20.0.5"])).apply();
      expect(await read()).to.equal("dhcp-relay=192.168.10.1,10.20.0.5");
    });

    it('should subscribe to the interface in relay mode too', async() => {
      ifaces.br1 = withAddress(["192.168.10.1/24"]);
      const plugin = build("br1", relayConfig(["10.20.0.5"]));
      await plugin.apply();
      expect(ifaces.br1.subscribers).to.deep.equal([plugin]);
    });

    it('should write nothing, warn and schedule no restart when the interface has no ipv4 yet', async() => {
      for (const addresses of [null, []]) {
        restarts = 0;
        ifaces.br1 = withAddress(addresses);
        await build("br1", relayConfig(["10.20.0.5"])).apply();
        expect(await read(), `addresses ${JSON.stringify(addresses)}`).to.be.null;
        expect(restarts).to.equal(0);
      }
    });

    it('should write nothing while the interface is not present', async() => {
      ifaces.br1 = stub.fakeInterface({isInterfacePresent: async () => false, getIPv4Addresses: async () => ["192.168.10.1/24"]});
      await build("br1", relayConfig(["10.20.0.5"])).apply();
      expect(await read()).to.be.null;
      expect(restarts).to.equal(0);
    });

    it('should leave the output of a local network as it was when relay is null or absent', async() => {
      ifaces.br1 = withAddress(["192.168.10.1/24"]);
      const expected = "dhcp-range=tag:br1,192.168.10.100,192.168.10.150,255.255.255.0,86400\n";
      for (const extra of [{}, {relay: null}]) {
        await build("br1", Object.assign({range, subnetMask: "255.255.255.0", lease: 86400}, extra)).apply();
        expect(await read()).to.equal(expected);
      }
    });

    it('should replace the whole file when a network switches between local and relay, and apply twice safely', async() => {
      ifaces.br1 = withAddress(["192.168.10.1/24"]);
      const local = build("br1");
      const relayed = build("br1", relayConfig(["10.20.0.5"]));
      // plugin_loader flushes the previous instance before it applies the new one
      await local.apply();
      expect(await read()).to.contain("dhcp-range=");
      await local.flush();
      await relayed.apply();
      expect(await read()).to.equal("dhcp-relay=192.168.10.1,10.20.0.5");
      await relayed.flush();
      await relayed.apply();
      expect(await read()).to.equal("dhcp-relay=192.168.10.1,10.20.0.5");
      await relayed.flush();
      await local.apply();
      const content = await read();
      expect(content).to.contain("dhcp-range=tag:br1,");
      expect(content).to.not.contain("dhcp-relay");
    });
  });
});
