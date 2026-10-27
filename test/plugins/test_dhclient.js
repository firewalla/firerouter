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
