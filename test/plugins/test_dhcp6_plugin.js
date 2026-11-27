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
const DHCP6Plugin = require('../../plugins/dhcp/dhcp6_plugin.js');
const pl = require('../../plugins/plugin_loader.js');


describe('Test DHCP6 configuration', function(){
  this.timeout(30000);

  beforeEach(() => {
    this.plugin = new DHCP6Plugin("eth5");
    this.plugin.configure({});
  });

  afterEach(async () => {
    await fs.unlinkAsync(this.plugin._getConfFilePath()).catch(() => null);
  });

  it('should use the default Router Advertisement lifetime of 3600 seconds', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5',
      [],
      'stateless',
      undefined,
      undefined,
      [],
      undefined,
      86400,
      200
    );

    const contents = await fs.readFileAsync(this.plugin._getConfFilePath(), {encoding: 'utf8'});
    expect(contents).to.contain('ra-param=eth5,200,3600');
  });

  it('should use the interval as the default Router Advertisement lifetime when it exceeds 3600 seconds', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5', [], 'stateless', undefined, undefined, [], undefined, 86400, 4000
    );

    const contents = await fs.readFileAsync(this.plugin._getConfFilePath(), {encoding: 'utf8'});
    expect(contents).to.contain('ra-param=eth5,4000,4000');
  });

  it('should allow Router Advertisement lifetime to be disabled with 0 seconds', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5',
      [],
      'stateless',
      undefined,
      undefined,
      [],
      undefined,
      86400,
      200,
      0
    );

    const contents = await fs.readFileAsync(this.plugin._getConfFilePath(), {encoding: 'utf8'});
    expect(contents).to.contain('ra-param=eth5,200,0');
  });

  it('should use a configured Router Advertisement lifetime in stateful mode', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5',
      [],
      'stateful',
      '2001:db8:1::10',
      '2001:db8:1::100',
      [],
      64,
      86400,
      200,
      900
    );

    const contents = await fs.readFileAsync(this.plugin._getConfFilePath(), {encoding: 'utf8'});
    expect(contents).to.contain('ra-param=eth5,200,900');
  });

  it('should advertise a renumbered-away prefix as an RA-only range', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5', [], 'stateless', undefined, undefined, [], undefined, 86400, 200, undefined,
      [{prefix: '2001:db8:1::/64', validLft: 6800}]
    );

    const contents = await fs.readFileAsync(this.plugin._getConfFilePath(), {encoding: 'utf8'});
    // the lease time bounds the valid lifetime, the keyword zeroes the preferred lifetime, and
    // an explicit range needs both - see the comment in writeDHCPConfFile
    // the unit suffix keeps dnsmasq from reading the number as a prefix length, which makes it
    // refuse to start - see the comment on DEPRECATED_PREFIX_RA_LEASE
    expect(contents).to.contain('dhcp-range=tag:eth5,2001:db8:1::,ra-only,120s');
    expect(contents).to.contain('dhcp-range=tag:eth5,2001:db8:1::,ra-only,deprecated');
    // the real remaining lifetime rides on the address's valid_lft and is never advertised as the
    // lease - doing so refreshes the dying address on every RA (RFC 4862 5.5.3(e) rule 1)
    expect(contents).to.not.contain('ra-only,6800');
    // the live prefix is still advertised alongside it
    expect(contents).to.contain('dhcp-range=tag:eth5,::,constructor:eth5,slaac,86400');
  });

  it('should scope the RA-only range with the same tags as the live range', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5', ['grp1'], 'stateless', undefined, undefined, [], undefined, 86400, 200, undefined,
      [{prefix: '2001:db8:1::/64', validLft: 6800}]
    );

    const contents = await fs.readFileAsync(this.plugin._getConfFilePath(), {encoding: 'utf8'});
    // a range carrying fewer tags than the live one would match a wider set of clients
    expect(contents).to.contain('dhcp-range=tag:eth5,tag:grp1,2001:db8:1::,ra-only,120s');
    expect(contents).to.contain('dhcp-range=tag:eth5,tag:grp1,2001:db8:1::,ra-only,deprecated');
  });

  it('should not write any RA-only range when no prefix was renumbered away', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5', [], 'stateless', undefined, undefined, [], undefined, 86400, 200
    );

    const contents = await fs.readFileAsync(this.plugin._getConfFilePath(), {encoding: 'utf8'});
    expect(contents).to.not.contain('ra-only');
  });

  it('should reject a nonzero Router Advertisement lifetime below the interval', async () => {
    let error = null;
    try {
      await this.plugin.writeDHCPConfFile(
        'eth5', [], 'stateless', undefined, undefined, [], undefined, 86400, 200, 199
      );
    } catch (err) {
      error = err;
    }

    expect(error).to.not.equal(null);
    expect(String(error)).to.contain('raLifetime');
  });

  it('should allow a Router Advertisement lifetime equal to the interval', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5', [], 'stateless', undefined, undefined, [], undefined, 86400, 200, 200
    );

    const contents = await fs.readFileAsync(this.plugin._getConfFilePath(), {encoding: 'utf8'});
    expect(contents).to.contain('ra-param=eth5,200,200');
  });

  it('should reject invalid Router Advertisement lifetimes', async () => {
    const invalidLifetimes = [-1, 65536, 1.5, '3600'];

    for (const raLifetime of invalidLifetimes) {
      let error = null;
      try {
        await this.plugin.writeDHCPConfFile(
          'eth5',
          [],
          'stateless',
          undefined,
          undefined,
          [],
          undefined,
          86400,
          200,
          raLifetime
        );
      } catch (err) {
        error = err;
      }

      expect(error).to.not.equal(null);
      expect(String(error)).to.contain('raLifetime');
    }
  });

  it('should reject invalid Router Advertisement lifetime before writing configuration', async () => {
    let error = null;
    try {
      await this.plugin.writeDHCPConfFile(
        'eth5',
        [],
        'stateless',
        undefined,
        undefined,
        [],
        undefined,
        86400,
        200,
        -1
      );
    } catch (err) {
      error = err;
    }

    expect(error).to.not.equal(null);
    const exists = await fs.accessAsync(this.plugin._getConfFilePath()).then(() => true).catch(() => false);
    expect(exists).to.equal(false);
  });
});

describe('Test DHCP6 plugin apply and flush', function(){
  this.timeout(30000);

  const confPath = path.join(os.tmpdir(), `firerouter_test_dhcp6_apply_${process.pid}.conf`);
  const origGetPluginInstance = pl.getPluginInstance;
  let ifaces;
  let restarts;

  const build = (name) => {
    const plugin = stub.build(DHCP6Plugin, name, {type: "stateless", lease: 86400, raInterval: 200});
    plugin._getConfFilePath = () => confPath;
    plugin._restartService = () => { restarts++; };
    return plugin;
  };
  const read = () => fs.readFileAsync(confPath, {encoding: 'utf8'}).catch(() => null);

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

  it('should subscribe to the interface, write its range and restart dhcp', async () => {
    ifaces.eth5 = stub.fakeInterface();
    const plugin = build("eth5");
    await plugin.apply();
    expect(ifaces.eth5.subscribers).to.deep.equal([plugin]);
    expect(await read()).to.contain('dhcp-range=tag:eth5,::,constructor:eth5,slaac,86400');
    expect(restarts).to.equal(1);
  });

  it('should tag a virtual interface by its parent but look it up by its own name', async () => {
    ifaces["br0:0"] = stub.fakeInterface();
    const plugin = build("br0:0");
    await plugin.apply();
    expect(ifaces["br0:0"].subscribers).to.deep.equal([plugin]);
    expect(await read()).to.contain('dhcp-range=tag:br0,::,constructor:br0:0,slaac,86400');
  });

  it('should advertise the prefixes the interface plugin reports as renumbered away', async () => {
    ifaces.eth5 = stub.fakeInterface({
      getDeprecatedIPv6Prefixes: async () => [{prefix: '2001:db8:1::/64', validLft: 6800}]
    });
    await build("eth5").apply();
    expect(await read()).to.contain('dhcp-range=tag:eth5,2001:db8:1::,ra-only,deprecated');
  });

  it('should write nothing and schedule no restart while the interface is not present', async () => {
    ifaces.eth5 = stub.fakeInterface({isInterfacePresent: async () => false});
    const plugin = build("eth5");
    await plugin.apply();
    expect(ifaces.eth5.subscribers).to.deep.equal([plugin]);
    expect(await read()).to.be.null;
    expect(restarts).to.equal(0);
  });

  it('should fail without an interface plugin and write nothing', async () => {
    let thrown = null;
    await build("eth5").apply().catch((err) => { thrown = err; });
    expect(thrown).to.equal("Interface plugin eth5 is not found");
    expect(await read()).to.be.null;
    expect(restarts).to.equal(0);
  });

  it('should flush its own _v6 conf file and schedule a restart', async () => {
    expect(new DHCP6Plugin("eth5")._getConfFilePath()).to.match(/\/eth5_v6\.conf$/);
    await fs.writeFileAsync(confPath, "enable-ra");
    await build("eth5").flush();
    expect(await read()).to.be.null;
    expect(restarts).to.equal(1);
  });
});
