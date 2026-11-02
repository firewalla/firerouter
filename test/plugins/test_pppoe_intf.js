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

  it('should keep an mru or mtu a client can already have saved', async() => {
    // the iOS app accepts an mru of 68 to 65535 and an mtu of 1280 to 9000
    // (NSNumber+VlanValidation.m), so a persisted value anywhere in those ranges has to reach the
    // options file unchanged rather than fall back to the default
    for (const mru of [68, 1492, 9000, 65535]) {
      const {content} = await generate({enabled: true, intf: "eth0", username: "u", password: "p", mru});
      expect(content, `mru ${mru} was not preserved`).to.contain(`mru ${mru}\n`);
    }
    for (const mtu of [1280, 1500, 9000]) {
      const {content} = await generate({enabled: true, intf: "eth0", username: "u", password: "p", mtu});
      expect(content, `mtu ${mtu} was not preserved`).to.contain(`mtu ${mtu}\n`);
    }
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

  it('should not let a credential splice the template into the config', async() => {
    // $& $` $' are String.replace substitution patterns, not control characters, so they pass
    // _quotedPPPDWord and would otherwise paste this template back into the value, newlines and all
    const base = await generate({enabled: true, intf: "eth0", username: "u", password: "p"});
    const baseLines = base.content.split("\n").length;
    for (const field of ["username", "password", "serviceName"]) {
      for (const payload of ["v$` plugin /tmp/pwn.so #", "v$' plugin /tmp/pwn.so #", "v$& plugin /tmp/pwn.so #"]) {
        const config = {enabled: true, intf: "eth0", username: "u", password: "p"};
        config[field] = payload;
        const {created, content} = await generate(config);
        expect(created, `${field} ${payload} should still produce a config`).to.be.true;
        log.debug(field, payload, content);
        expect(injected(content), `${field} ${payload} added a pppd option`).to.deep.equal([]);
        // the value stays one word on its own line: serviceName appends a line of its own, and
        // nothing else may change the line count, which a spliced-in copy of the template would
        expect(content.split("\n").length, `${field} ${payload} added lines to the options file`)
          .to.equal(baseLines + (field === "serviceName" ? 1 : 0));
      }
    }
  });

  // The written form on the left of each pair is what pppd's getword() decodes back to the
  // configured value. Confirmed against the real parser on a box with
  //   sudo pppd dryrun /dev/null file <conf>
  // which prints the options it parsed and exits without dialling; see test/CLAUDE.md.
  it('should encode a credential so pppd reads back what was configured', async() => {
    const cases = [
      ["p@ss w0rd!", "p@ss w0rd!"],      // nothing pppd treats as syntax
      ["a\\b", "a\\\\b"],                // unescaped, \b is a backspace
      ["a\\\\b", "a\\\\\\\\b"],          // each backslash stands for itself
      ["trailing\\", "trailing\\\\"],    // unescaped, this eats the closing quote
      ["has'quote", "has\\'quote"],      // \' is a quote that does not close the word
      ["\\x41hex", "\\\\x41hex"],        // unescaped, this arrives as "Ahex"
      ["\\101octal", "\\\\101octal"]
    ];
    for (const [configured, written] of cases) {
      const {created, content} = await generate({enabled: true, intf: "eth0", username: configured, password: "p"});
      expect(created, `${JSON.stringify(configured)} should produce a config`).to.be.true;
      log.debug(JSON.stringify(configured), "->", JSON.stringify(written));
      // the whole line, not a substring of it: anything appended after the closing quote would still
      // satisfy a contains(), and injected() only sees an option that starts a line of its own
      expect(content.split("\n"), `${JSON.stringify(configured)} was not encoded as ${JSON.stringify(written)}`)
        .to.include(`user '${written}'`);
      expect(injected(content), `${JSON.stringify(configured)} added a pppd option`).to.deep.equal([]);
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
