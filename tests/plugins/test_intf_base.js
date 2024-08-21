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

let InterfaceBasePlugin = require('../../plugins/interface/intf_base_plugin.js');

describe('Test interface base dhcp6', function(){
    this.timeout(30000);

    before((done) => (
      async() => {
        this.plugin = new InterfaceBasePlugin("eth0");
        this.plugin.configure({dhcp6:{}});
        await this.plugin._unsetDuid();
        done();
      })()
    );

    after((done) => {
      done();
    });

    it('should generate duid', async()=> {
      let newDuid;
      let duid = await this.plugin._getDuid();
      log.debug("current duid", duid);

      newDuid = await this.plugin._genDuid('DUID-LLT');
      duid = await this.plugin._getDuid();
      log.debug('new DUID-LLT', duid);
      expect(duid).to.be.eql(newDuid);
      expect(duid).to.contains('00:01:');

      newDuid = await this.plugin._genDuid('DUID-LL');
      duid = await this.plugin._getDuid();
      log.debug('new DUID-LL', duid);
      expect(duid).to.be.eql(newDuid);
      expect(duid).to.contains('00:03:');

      newDuid = await this.plugin._genDuid('DUID-UUID');
      duid = await this.plugin._getDuid();
      log.debug('new DUID-UUID', duid);
      expect(duid).to.be.eql(newDuid);
      expect(duid).to.contains('00:04:');
    });

    it('should get last duid', async() => {
      let duid = await this.plugin._getDuid();
      log.debug("current duid", duid);
      let lastDuid = await this.plugin.getLastDuid();
      log.debug("last duid", lastDuid);
      expect(lastDuid).to.be.contains("00:03:");
    });

    it('should unset duid', async() => {
      await this.plugin._unsetDuid();
      expect(await this.plugin.getLastDuid()).to.be.equal(null);
      let duid = await this.plugin._getDuid();
      expect(duid).to.be.empty;
    });

    it('should get duid type', async() => {
      expect(this.plugin._getDuidType('00:01:00:01:66:97:49:e4:20:6d:31:01:2b:43')).to.be.equal('DUID-LLT');
      expect(this.plugin._getDuidType('00:03:00:01:20:6d:31:01:2b:43')).to.be.equal('DUID-LL');
      expect(this.plugin._getDuidType('00:04:7e:89:20:22:89:15:45:b8:ac:05:3c:68:2b:08:04:8f')).to.be.equal('DUID-UUID');
    });
  });
