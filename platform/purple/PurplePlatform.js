/*    Copyright 2021 Firewalla Inc.
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

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const Platform = require('../Platform.js');

const firestatusBaseURL = "http://127.0.0.1:9966";
const exec = require('child-process-promise').exec;

class PurplePlatform extends Platform {
  getName() {
    return "purple";
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/files/default_setup.json`;
  }

  async getWlanVendor() {
    if ( !this.vendor ) {
      try {
        const procCmdline = await fs.readFileAsync("/proc/cmdline", {encoding: 'utf8'});
        this.vendor = procCmdline.match(' wifi_rev=([0-9a-z]*) ')[1];
      } catch(err) {
        log.error("Failed to parse wifi_rev from /proc/cmdline", err.message);
        return "unknown";
      }
    }
    return this.vendor;
  }

  getWpaCliBinPath() {
    return `${__dirname}/bin/wpa_cli`;
  }

  getWpaPassphraseBinPath() {
    return `${__dirname}/bin/wpa_passphrase`;
  }

  async ledNormalVisibleStart() {
    await exec(`curl -s '${firestatusBaseURL}/fire?name=firerouter&type=normal_visible'`).catch( (err) => {
      log.error("Failed to set LED as WAN normal visible");
    });
  }

  async ledNormalVisibleStop() {
    await exec(`curl -s '${firestatusBaseURL}/resolve?name=firerouter&type=normal_visible'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAllNetworkDown() {
    await exec(`curl -s '${firestatusBaseURL}/fire?name=firerouter&type=network_down'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAnyNetworkUp() {
    await exec(`curl -s '${firestatusBaseURL}/resolve?name=firerouter&type=network_down'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

}

module.exports = PurplePlatform;
