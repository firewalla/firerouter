'use strict'

const chai = require('chai');
const expect = chai.expect;
const fs = require('fs');
const os = require('os');
const path = require('path');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DHCP6Plugin = require('../../plugins/dhcp/dhcp6_plugin.js');

describe('Test DHCPv6 configuration validation', function() {
  this.timeout(30000);

  let plugin;
  let tempDir;
  let confFilePath;

  before(async () => {
    tempDir = await fs.mkdtempAsync(
      path.join(os.tmpdir(), 'firerouter-dhcp6-')
    );

    confFilePath = path.join(tempDir, 'br0_v6.conf');

    plugin = new DHCP6Plugin('br0');

    // Isolate the test from the real router configuration directory.
    plugin._getConfFilePath = () => confFilePath;
  });

  it('should accept a valid stateful DHCPv6 configuration', async () => {
    plugin.configure({
      type: 'stateful'
    });

    await plugin.writeDHCPConfFile(
      'br0',
      [],
      'stateful',
      'fd00::100',
      'fd00::1ff',
      [],
      64,
      86400,
      200
    );

    const content = await fs.readFileAsync(
      plugin._getConfFilePath(),
      'utf8'
    );

    expect(content).to.include(
      'dhcp-range=tag:br0,fd00::100,fd00::1ff,64,86400'
    );
  });

  it('should preserve the existing configuration when validation fails', async () => {
    await plugin.writeDHCPConfFile(
      'br0',
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
      plugin._getConfFilePath(),
      'utf8'
    );

    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'invalid',
        'fd00::1ff',
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected invalid configuration to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'from is not a valid IPv6 address'
      );
    }

    const current = await fs.readFileAsync(
      plugin._getConfFilePath(),
      'utf8'
    );

    expect(current).to.equal(original);
  });

  it('should reject a missing from address', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        null,
        'fd00::1ff',
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected missing from address to be rejected');
    } catch (err) {
      expect(String(err)).to.include('from/to is not specified');
    }
  });

  it('should reject a missing to address', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::100',
        null,
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected missing to address to be rejected');
    } catch (err) {
      expect(String(err)).to.include('from/to is not specified');
    }
  });

  it('should reject an invalid from address', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'not-an-ipv6-address',
        'fd00::1ff',
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected invalid from address to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'from is not a valid IPv6 address'
      );
    }
  });

  it('should reject an invalid to address', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::100',
        'not-an-ipv6-address',
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected invalid to address to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'to is not a valid IPv6 address'
      );
    }
  });

  it('should reject a from address containing a prefix', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::100/64',
        'fd00::1ff',
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected prefixed from address to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'from is not a valid IPv6 address'
      );
    }
  });

  it('should reject a to address containing a prefix', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::100',
        'fd00::1ff/64',
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected prefixed to address to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'to is not a valid IPv6 address'
      );
    }
  });

  it('should reject a scoped from address', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fe80::1%eth0',
        'fd00::1ff',
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected scoped from address to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'from is not a valid IPv6 address'
      );
    }
  });

  it('should reject a scoped to address', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::100',
        'fe80::2%eth0',
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected scoped to address to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'to is not a valid IPv6 address'
      );
    }
  });

  it('should reject a reversed DHCPv6 range', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::200',
        'fd00::100',
        [],
        64,
        86400,
        200
      );
      expect.fail('Expected reversed DHCPv6 range to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'from address must not be greater than to address'
      );
    }
  });

  it('should reject DHCPv6 range endpoints outside the same prefix', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::100',
        'fd00:0:0:1::100',
        [],
        64,
        86400,
        200
      );
      expect.fail(
        'Expected DHCPv6 endpoints outside the same prefix to be rejected'
      );
    } catch (err) {
      expect(String(err)).to.include(
        'from/to addresses must be in the same prefix'
      );
    }
  });

  it('should reject a prefix length below 64', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::100',
        'fd00::1ff',
        [],
        63,
        86400,
        200
      );
      expect.fail('Expected prefix length below 64 to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'prefixLen for dhcp6 of br0 should be an integer between 64 and 128'
      );
    }
  });

  it('should reject a prefix length above 128', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::100',
        'fd00::1ff',
        [],
        129,
        86400,
        200
      );
      expect.fail('Expected prefix length above 128 to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'prefixLen for dhcp6 of br0 should be an integer between 64 and 128'
      );
    }
  });

  it('should reject a non-integer prefix length', async () => {
    try {
      await plugin.writeDHCPConfFile(
        'br0',
        [],
        'stateful',
        'fd00::100',
        'fd00::1ff',
        [],
        64.5,
        86400,
        200
      );
      expect.fail('Expected non-integer prefix length to be rejected');
    } catch (err) {
      expect(String(err)).to.include(
        'prefixLen for dhcp6 of br0 should be an integer between 64 and 128'
      );
    }
  });

  it('should accept prefix length 64', async () => {
    await plugin.writeDHCPConfFile(
      'br0',
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

  it('should accept prefix length 128', async () => {
    await plugin.writeDHCPConfFile(
      'br0',
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

  after(async () => {
    await fs.rmAsync(tempDir, {
      recursive: true,
      force: true
    });
  });
});
