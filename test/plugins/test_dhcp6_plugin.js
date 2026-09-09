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

const DHCP6Plugin = require('../../plugins/dhcp/dhcp6_plugin.js');


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
