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
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DHCP6Plugin = require('../../plugins/dhcp/dhcp6_plugin.js');


async function expectDHCP6ConfigError(plugin, args, message) {
  let error = null;

  try {
    await plugin.writeDHCPConfFile(...args);
  } catch (err) {
    error = err;
  }

  expect(error).to.not.equal(null);
  expect(String(error)).to.contain(message);
}


describe('Test DHCP6 configuration', function(){
  this.timeout(30000);

  beforeEach(() => {
    this.plugin = new DHCP6Plugin("eth5");
    this.plugin.configure({});

    this.testConfDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'firerouter-dhcp6-')
    );

    this.plugin._getConfFilePath = () =>
      path.join(this.testConfDir, 'eth5_v6.conf');
  });

  afterEach(async () => {
    await fs.unlinkAsync(this.plugin._getConfFilePath()).catch(() => null);
    await fs.rmdirAsync(this.testConfDir).catch(() => null);
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

    const exists = await fs.accessAsync(
      this.plugin._getConfFilePath()
    ).then(() => true).catch(() => false);

    expect(exists).to.equal(false);
  });

  it('should accept a valid stateful DHCPv6 configuration', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5',
      [],
      'stateful',
      'fd00::100',
      'fd00::1ff',
      [],
      64,
      86400,
      200
    );

    const contents = await fs.readFileAsync(
      this.plugin._getConfFilePath(),
      {encoding: 'utf8'}
    );

    expect(contents).to.contain(
      'dhcp-range=tag:eth5,fd00::100,fd00::1ff,64,86400'
    );

    expect(contents).to.contain('enable-ra');
    expect(contents).to.contain('ra-param=eth5,200,3600');
  });

  it('should preserve the existing configuration when validation fails', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5',
      [],
      'stateful',
      'fd00::100',
      'fd00::1ff',
      [],
      64,
      86400,
      200
    );

    const original = await fs.readFileAsync(
      this.plugin._getConfFilePath(),
      'utf8'
    );

    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'invalid',
        'fd00::1ff',
        [],
        64,
        86400,
        200
      ],
      'from is not a valid IPv6 address'
    );

    const current = await fs.readFileAsync(
      this.plugin._getConfFilePath(),
      'utf8'
    );

    expect(current).to.equal(original);
  });

  it('should reject a missing from address', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        null,
        'fd00::1ff',
        [],
        64,
        86400,
        200
      ],
      'from/to is not specified'
    );
  });

  it('should reject a missing to address', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'fd00::100',
        null,
        [],
        64,
        86400,
        200
      ],
      'from/to is not specified'
    );
  });

  it('should reject an invalid from address', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'not-an-ipv6-address',
        'fd00::1ff',
        [],
        64,
        86400,
        200
      ],
      'from is not a valid IPv6 address'
    );
  });

  it('should reject an invalid to address', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'fd00::100',
        'not-an-ipv6-address',
        [],
        64,
        86400,
        200
      ],
      'to is not a valid IPv6 address'
    );
  });

  it('should reject a from address containing a prefix', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'fd00::100/64',
        'fd00::1ff',
        [],
        64,
        86400,
        200
      ],
      'from is not a valid IPv6 address'
    );
  });

  it('should reject a to address containing a prefix', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'fd00::100',
        'fd00::1ff/64',
        [],
        64,
        86400,
        200
      ],
      'to is not a valid IPv6 address'
    );
  });

  it('should reject a scoped from address', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'fe80::1%eth0',
        'fe80::2%eth0',
        [],
        64,
        86400,
        200
      ],
      'from is not a valid IPv6 address'
    );
  });

  it('should reject a scoped to address', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'fd00::100',
        'fe80::2%eth0',
        [],
        64,
        86400,
        200
      ],
      'to is not a valid IPv6 address'
    );
  });

  it('should reject a reversed DHCPv6 range', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'fd00::200',
        'fd00::100',
        [],
        64,
        86400,
        200
      ],
      'from address must not be greater than to address'
    );
  });

  it('should reject DHCPv6 range endpoints outside the same prefix', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'fd00::100',
        'fd00:0:0:1::100',
        [],
        64,
        86400,
        200
      ],
      'from/to addresses must be in the same prefix'
    );
  });

  const invalidPrefixLengths = [
    {
      value: 63,
      description: 'below 64'
    },
    {
      value: 129,
      description: 'above 128'
    },
    {
      value: 64.5,
      description: 'a non-integer'
    },
    {
      value: '64',
      description: 'a string'
    }
  ];

  invalidPrefixLengths.forEach(({value, description}) => {
    it(`should reject a prefix length ${description}`, async () => {
      await expectDHCP6ConfigError(
        this.plugin,
        [
          'eth5',
          [],
          'stateful',
          'fd00::100',
          'fd00::1ff',
          [],
          value,
          86400,
          200
        ],
        'prefixLen for dhcp6 of eth5 should be an integer between 64 and 128'
      );
    });
  });

  it('should accept prefix length 64', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5',
      [],
      'stateful',
      'fd00::100',
      'fd00::1ff',
      [],
      64,
      86400,
      200
    );
  });

  it('should accept an equal-address DHCPv6 range', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5',
      [],
      'stateful',
      'fd00::100',
      'fd00::100',
      [],
      128,
      86400,
      200
    );

    const contents = await fs.readFileAsync(
      this.plugin._getConfFilePath(),
      {encoding: 'utf8'}
    );

    expect(contents).to.contain(
      'dhcp-range=tag:eth5,fd00::100,fd00::100,128,86400'
    );
  });

  it('should accept distinct endpoints within a /127 prefix', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5',
      [],
      'stateful',
      'fd00::100',
      'fd00::101',
      [],
      127,
      86400,
      200
    );
  });

  it('should reject a /128 range with different endpoints', async () => {
    await expectDHCP6ConfigError(
      this.plugin,
      [
        'eth5',
        [],
        'stateful',
        'fd00::100',
        'fd00::101',
        [],
        128,
        86400,
        200
      ],
      'from/to addresses must be in the same prefix'
    );
  });

  it('should accept prefix length 128', async () => {
    await this.plugin.writeDHCPConfFile(
      'eth5',
      [],
      'stateful',
      'fd00::100',
      'fd00::100',
      [],
      128,
      86400,
      200
    );
  });
});
