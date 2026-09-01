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

const childProcess = require('child-process-promise');
const originalExec = childProcess.exec;
let execImpl = originalExec;
childProcess.exec = (...args) => execImpl(...args);
const exec = originalExec;

let log = require('../../util/logger.js')(__filename, 'info');

let DNSPlugin = require('../../plugins/dns/dns_plugin.js');

describe('Test interface base dhcp6', function(){
    this.timeout(30000);

    before(async () => {
        this.plugin = new DNSPlugin("eth5");
        this.plugin.configure({useNameserversFromWAN: false, dns6Servers: ["2606:4700:4700::1111", "2001:4860:4860::8888"]});
    });

    after(async () => {
        await exec(`rm ${this.plugin._getResolvFilePath()}`).catch(err=>null);
        await exec(`rm ${this.plugin._getConfFilePath()}`).catch(err=>null);
        childProcess.exec = originalExec;
    });

    it('should preserve localhost upstream configuration when listener is unavailable', async() => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const fireRouter = require('../../util/firerouter');

      const originalGetFirewallaUserConfigFolder = fireRouter.getFirewallaUserConfigFolder;
      const originalCreateDirectories = DNSPlugin.createDirectories;
      const originalInstallDNSScript = DNSPlugin.installDNSScript;
      const originalInstallSystemService = DNSPlugin.installSystemService;
      const originalAccessAsync = fs.accessAsync;
      const originalWriteFileAsync = fs.writeFileAsync;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firerouter-dns-test-'));
      const confDir = path.join(tempDir, 'dnsmasq');
      const confPath = path.join(confDir, 'localhost-upstream.conf');
      const markerPath = '/dev/shm/firerouter_dns_boot_cleanup_done';

      fs.mkdirSync(confDir, {recursive: true});
      fs.writeFileSync(confPath, 'server=127.0.0.1#5353\n');

      execImpl = async (command) => {
        if (command.startsWith('grep -rl')) {
          return {stdout: confPath + '\n'};
        }
        if (command.startsWith('ss -lntu')) {
          throw new Error('listener unavailable');
        }
        return {stdout: ''};
      };

      fireRouter.getFirewallaUserConfigFolder = () => tempDir;
      DNSPlugin.createDirectories = async () => {};
      DNSPlugin.installDNSScript = async () => {};
      DNSPlugin.installSystemService = async () => {};

      // Prevent the old boot-cleanup implementation from creating a shared /dev/shm marker.
      fs.accessAsync = async (filePath) => {
        if (filePath === markerPath) {
          throw new Error('marker not found');
        }
        return originalAccessAsync(filePath);
      };
      fs.writeFileAsync = async (filePath, ...args) => {
        if (filePath === markerPath) {
          return;
        }
        return originalWriteFileAsync(filePath, ...args);
      };

      try {
        await DNSPlugin.preparePlugin();
        expect(fs.existsSync(confPath)).to.equal(true);
        expect(fs.readFileSync(confPath, 'utf8')).to.equal('server=127.0.0.1#5353\n');
      } finally {
        execImpl = originalExec;
        fireRouter.getFirewallaUserConfigFolder = originalGetFirewallaUserConfigFolder;
        DNSPlugin.createDirectories = originalCreateDirectories;
        DNSPlugin.installDNSScript = originalInstallDNSScript;
        DNSPlugin.installSystemService = originalInstallSystemService;
        fs.accessAsync = originalAccessAsync;
        fs.writeFileAsync = originalWriteFileAsync;
        fs.rmSync(tempDir, {recursive: true, force: true});
      }
    });

    it('should dns6', async() => {
      this._intfUuid = "fake-uuid";
      await this.plugin.writeDNSConfFile();
      log.debug(`dns resolv ${this.plugin._getResolvFilePath()}\n`, await exec(`cat ${this.plugin._getResolvFilePath()}`).then(r => r.stdout.trim()).catch(err => null));
    });
  });
