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

const exec = require('child-process-promise').exec;
let log = require('../../util/logger.js')(__filename, 'info');

let DNSPlugin = require('../../plugins/dns/dns_plugin.js');

describe('Test interface base dhcp6', function(){
    this.timeout(30000);

    before((done) => (
      async() => {
        this.plugin = new DNSPlugin("eth5");
        this.plugin.configure({useNameserversFromWAN: false, dns6Servers: ["2606:4700:4700::1111", "2001:4860:4860::8888"]});
        done();
      })()
    );

    after((done) => (
      async() => {
        await exec(`rm ${this.plugin._getResolvFilePath()}`).catch(err=>null);
        await exec(`rm ${this.plugin._getConfFilePath()}`).catch(err=>null);
        done();
    })()
    );

    it('should dns6', async() => {
      this._intfUuid = "fake-uuid";
      await this.plugin.writeDNSConfFile();
      log.debug(`dns resolv ${this.plugin._getResolvFilePath()}\n`, await exec(`cat ${this.plugin._getResolvFilePath()}`).then(r => r.stdout.trim()).catch(err => null));
    });
  });
