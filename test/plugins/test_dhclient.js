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
// sets FIREROUTER_HOME, so it goes before anything that loads the plugins
const stub = require('./stub_exec.js');

const r = require('../../util/firerouter');
let log = require('../../util/logger.js')(__filename, 'info');
let InterfaceBasePlugin = require("../../plugins/interface/intf_base_plugin.js");

describe('Test populate etc conf templates', function(){
  this.timeout(30000);

  beforeEach((done) => {
    this.plugin = new InterfaceBasePlugin("eth0");
    this.plugin.configure({});
    done();
  });

  afterEach((done) => {
    done();
  });

  it('should populate dhclient conf', async()=> {
    // do not call applyIpSettings (not to restart firerouter dhclient)
    const dhcpOptions = ["select-timeout 0;"];

    let dhclientConf = await fs.readFileAsync(`${r.getFireRouterHome()}/etc/dhclient.conf.template`, {encoding: "utf8"});
    dhclientConf=this.plugin._overrideNTPoverDHCP(dhclientConf);
    dhclientConf = dhclientConf.replace(/%ADDITIONAL_OPTIONS%/g, dhcpOptions.join("\n"));
    await fs.writeFileAsync(this.plugin._getDHClientConfigPath(), dhclientConf);

    const contents = await fs.readFileAsync(this.plugin._getDHClientConfigPath(), {encoding: "utf8"});
    log.debug(contents);

    expect(contents).to.contains("timeout 300;");
    expect(contents).to.contains("domain-search,");
    expect(contents).to.contains("rfc3442-classless-static-routes;");
    expect(contents).not.to.contains("ntp-servers");
  });


  it('should populate dhclient conf, allowNTPviaDHCP', async()=> {
    // do not call applyIpSettings (not to restart firerouter dhclient)
    const dhcpOptions = ["select-timeout 0;"];
    const allowNTPviaDHCP = true;
    this.plugin.configure({allowNTPviaDHCP});

    let dhclientConf = await fs.readFileAsync(`${r.getFireRouterHome()}/etc/dhclient.conf.template`, {encoding: "utf8"});
    dhclientConf=this.plugin._overrideNTPoverDHCP(dhclientConf);
    dhclientConf = dhclientConf.replace(/%ADDITIONAL_OPTIONS%/g, dhcpOptions.join("\n"));
    await fs.writeFileAsync(this.plugin._getDHClientConfigPath(), dhclientConf);

    const contents = await fs.readFileAsync(this.plugin._getDHClientConfigPath(), {encoding: "utf8"});
    log.debug(contents);

    expect(contents).to.contains("timeout 300;");
    expect(contents).to.contains("select-timeout 0;");
    expect(contents).to.contains("domain-search, dhcp6.sntp-servers,");
    expect(contents).to.contains("rfc3442-classless-static-routes, ntp-servers;");

  });

  // the request list above only decides what is asked for, some DHCP servers announce ntp-servers
  // regardless, so this env file is what keeps the NTP exit hooks off an interface
  it('should populate dhclient env', async()=> {
    await fs.writeFileAsync(this.plugin._getDHClientEnvPath(), this.plugin._getDHClientEnvContent());

    const contents = await fs.readFileAsync(this.plugin._getDHClientEnvPath(), {encoding: "utf8"});
    log.debug(contents);

    expect(contents).to.equal("FR_ALLOW_NTP=0\n");
  });

  it('should populate dhclient env, allowNTPviaDHCP', async()=> {
    const allowNTPviaDHCP = true;
    this.plugin.configure({allowNTPviaDHCP});

    await fs.writeFileAsync(this.plugin._getDHClientEnvPath(), this.plugin._getDHClientEnvContent());

    const contents = await fs.readFileAsync(this.plugin._getDHClientEnvPath(), {encoding: "utf8"});
    log.debug(contents);

    expect(contents).to.equal("FR_ALLOW_NTP=1\n");
  });
});

describe('Test dhclient send options', function(){
  this.timeout(30000);

  const os = require('os');
  const path = require('path');
  const StubbedPlugin = stub.load(require.resolve('../../plugins/interface/intf_base_plugin.js'));
  let warns;

  function build(dhcpOptions) {
    const plugin = stub.build(StubbedPlugin, "eth0", {dhcp: true, dhcpOptions});
    plugin.log = Object.create(plugin.log);
    plugin.log.warn = (msg) => warns.push(msg);
    return plugin;
  }

  beforeEach(() => {
    stub.reset();
    warns = [];
  });

  it('should write lease time as a bare number, from a string or a number', () => {
    expect(build({"dhcp-lease-time": "3600"})._getDHClientSendOptions()).to.eql(['send dhcp-lease-time 3600;']);
    expect(build({"dhcp-lease-time": 7200})._getDHClientSendOptions()).to.eql(['send dhcp-lease-time 7200;']);
    expect(build({"dhcp-lease-time": " 3600 "})._getDHClientSendOptions()).to.eql(['send dhcp-lease-time 3600;']);
    expect(build({"dhcp-lease-time": "4294967295"})._getDHClientSendOptions()).to.eql(['send dhcp-lease-time 4294967295;']);
    expect(warns).to.be.empty;
  });

  it('should skip an unusable lease time with a warn and keep the other options', () => {
    for (const bad of ["abcuio", "0", 0, "-1", "4294967296", "1.5", "", [3600], true, null]) {
      warns = [];
      const lines = build({"host-name": "fr-test", "dhcp-lease-time": bad, "vendor-class-identifier": "MSFT 5.0"})._getDHClientSendOptions();
      expect(lines, JSON.stringify(bad)).to.eql(['send host-name "fr-test";', 'send vendor-class-identifier "MSFT 5.0";']);
      expect(warns.length, JSON.stringify(bad)).to.equal(1);
      expect(warns[0]).to.contain("eth0").and.contain("dhcp-lease-time");
    }
    build({"dhcp-lease-time": "abcuio"})._getDHClientSendOptions();
    expect(warns.pop()).to.contain("abcuio");
  });

  it('should write plain text options as before', () => {
    expect(build({"host-name": "fr-test", "vendor-class-identifier": "MSFT 5.0", "dhcp-client-identifier": "01:aa:bb", "vendor-encapsulated-options": "abc"})._getDHClientSendOptions()).to.eql([
      'send host-name "fr-test";',
      'send vendor-class-identifier "MSFT 5.0";',
      'send dhcp-client-identifier "01:aa:bb";',
      'send vendor-encapsulated-options "abc";',
    ]);
  });

  it('should escape what would end a text value early and keep dhclient escapes as typed', () => {
    const cases = [
      ['MS"FT', 'MS\\"FT'],
      ['MS"FT\\001x', 'MS\\"FT\\001x'],
      ['\\x01abc', '\\x01abc'],
      ['a\\"b', 'a\\"b'],
      ['a\\\\"b', 'a\\\\\\"b'],
      ['abc\\', 'abc\\\\'],
      ['abc\\\\', 'abc\\\\'],
      ['"', '\\"'],
    ];
    for (const [value, written] of cases)
      expect(build({"vendor-class-identifier": value})._getDHClientSendOptions(), value).to.eql([`send vendor-class-identifier "${written}";`]);
  });

  it('should keep config key order, unknown keys as quoted text', () => {
    expect(build({"my-option": "x", "dhcp-lease-time": "3600", "host-name": "fr-test", "user-class": 5})._getDHClientSendOptions()).to.eql([
      'send my-option "x";',
      'send dhcp-lease-time 3600;',
      'send host-name "fr-test";',
      'send user-class "5";',
    ]);
  });

  it('should skip a key that is not a dhclient option name', () => {
    const lines = build({"host-name": "fr-test", "foo; reboot": "x", "foo bar": "y", "space.my-opt": "z"})._getDHClientSendOptions();
    expect(lines).to.eql(['send host-name "fr-test";', 'send space.my-opt "z";']);
    expect(warns.length).to.equal(2);
    expect(warns[0]).to.contain("eth0").and.contain("foo; reboot");
  });

  it('should write no lines without options', () => {
    expect(build(undefined)._getDHClientSendOptions()).to.eql([]);
    expect(build({})._getDHClientSendOptions()).to.eql([]);
  });

  it('should write values with $ patterns as typed into dhclient conf', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dhclient-test-"));
    const plugin = build({"host-name": "a$&b$$c$`d$'e", "dhcp-lease-time": "3600"});
    plugin._getDHClientConfigPath = () => path.join(dir, "eth0.conf");
    plugin._getDHClientEnvPath = () => path.join(dir, "eth0.env");
    await plugin.applyIpSettings();
    const contents = await fs.promises.readFile(path.join(dir, "eth0.conf"), {encoding: "utf8"});
    expect(contents).to.contain('send host-name "a$&b$$c$`d$\'e";\nsend dhcp-lease-time 3600;');
    expect(contents).not.to.contain("%ADDITIONAL_OPTIONS%");
    expect(stub.matching("firerouter_dhclient@eth0")).to.eql(["sudo systemctl restart firerouter_dhclient@eth0"]);
    await fs.promises.rm(dir, {recursive: true});
  });
});
