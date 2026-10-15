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
const pl = require('../../plugins/plugin_loader.js');
const PPPoEInterfacePlugin = stub.load(require.resolve('../../plugins/interface/pppoe_intf_plugin.js'));
let log = require('../../util/logger.js')(__filename, 'info');

// createInterface fills etc/ppp.conf.template and pppd reads the result as an options file.
// scripts/firerouter_pppd@.service has no User= of its own, so pppd reads it as root and the
// privileged options in it take effect. pppd reads that file word by word, so both a line break
// and an unescaped quote end a value and let whatever follows be taken as another pppd option.
describe('Test pppoe interface plugin', function(){
  this.timeout(30000);

  const confPath = path.join(os.tmpdir(), `firerouter_test_ppp_${process.pid}.conf`);

  // a directive that would hand pppd an attacker controlled shared object or shell command
  const PRIVILEGED = /^\s*(plugin|pty|init|connect|disconnect|welcome)\b/;

  const generate = async (config) => {
    stub.reset();
    await fs.unlinkAsync(confPath).catch(() => {});
    const plugin = stub.build(PPPoEInterfacePlugin, "ppp0", config);
    plugin._getConfFilePath = () => confPath;
    plugin.subscribeChangeFrom = () => {};
    const created = await plugin.createInterface().catch(() => false);
    const content = await fs.readFileAsync(confPath, {encoding: "utf8"}).catch(() => null);
    return {created, content};
  };

  const injected = (content) => content.split("\n")
    .filter(l => PRIVILEGED.test(l) && !/^plugin rp-pppoe\.so /.test(l));

  before(() => {
    // without the loader there is no lower interface to find, and createInterface writes the file
    // only after it resolves one
    this.origGetPluginInstance = pl.getPluginInstance;
    pl.getPluginInstance = () => ({});
  });

  after(async () => {
    pl.getPluginInstance = this.origGetPluginInstance;
    await fs.unlinkAsync(confPath).catch(() => {});
  });

  it('should not let mru or mtu add a pppd option', async() => {
    for (const mru of ["1492\nplugin /tmp/pwn.so", "1492\npty /tmp/pwn.sh", "Infinity", 2.5, "not-a-number"]) {
      const {created, content} = await generate({enabled: true, intf: "eth0", username: "u", password: "p", mru});
      expect(created, `mru ${JSON.stringify(mru)} should still produce a config`).to.be.true;
      log.debug(`mru ${JSON.stringify(mru)}`, injected(content));
      expect(injected(content), `mru ${JSON.stringify(mru)} added a pppd option`).to.deep.equal([]);
      expect(content).to.contain("mru 1492");
    }
    const {content} = await generate({enabled: true, intf: "eth0", username: "u", password: "p", mtu: "1492\nplugin /tmp/pwn.so"});
    expect(injected(content), 'mtu added a pppd option').to.deep.equal([]);
  });

  it('should refuse a credential or service name holding a line break', async() => {
    for (const field of ["username", "password", "serviceName"]) {
      const config = {enabled: true, intf: "eth0", username: "u", password: "p"};
      config[field] = `value\nplugin /tmp/pwn.so`;
      const {created, content} = await generate(config);
      expect(created, `${field} with a line break should be rejected`).to.be.false;
      expect(content, `no config file should be written for ${field}`).to.be.null;
    }
  });

  it('should not let a quote in a credential end the quoted word', async() => {
    for (const field of ["username", "password", "serviceName"]) {
      const config = {enabled: true, intf: "eth0", username: "u", password: "p"};
      config[field] = `value' plugin /tmp/pwn.so #`;
      const {created, content} = await generate(config);
      expect(created, `${field} should still produce a config`).to.be.true;
      log.debug(field, injected(content));
      expect(injected(content), `${field} added a pppd option`).to.deep.equal([]);
      expect(content, `${field} quote was not escaped`).to.contain("value\\'");
    }
  });

  it('should generate an ordinary pppoe config', async() => {
    const {created, content} = await generate({
      enabled: true, intf: "eth0", username: "user@isp.example", password: "p@ss w0rd!",
      mru: 1400, mtu: "1400", serviceName: "my-service"
    });
    expect(created).to.be.true;
    log.debug("ppp.conf\n", content);
    expect(content).to.contain("user 'user@isp.example'");
    expect(content).to.contain("password 'p@ss w0rd!'");
    expect(content).to.contain("plugin rp-pppoe.so eth0");
    expect(content).to.contain("mru 1400");
    expect(content).to.contain("mtu 1400");
    expect(content).to.contain("linkname ppp0");
    expect(content).to.contain("rp_pppoe_service 'my-service'");
    expect(injected(content)).to.deep.equal([]);
  });
});
