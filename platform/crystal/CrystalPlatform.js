/*    Copyright 2016-2026 Firewalla Inc.
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

'use strict';

const Platform = require('../Platform.js');
const fs = require('fs');
const os = require('os');

const SYSTEM_AWG_BIN_PATH = '/usr/bin/awg';

class CrystalPlatform extends Platform {
  getName() {
    return "crystal";
  }

  getAwgBinPath() {
    const repoKoPath = `${this.getFilesPath()}/kernel_modules/${os.release()}/amneziawg.ko`;
    if (fs.existsSync(repoKoPath)) {
      return super.getAwgBinPath();
    }
    if (fs.existsSync(SYSTEM_AWG_BIN_PATH)) {
      return SYSTEM_AWG_BIN_PATH;
    }
    return super.getAwgBinPath();
  }

  isOnboardConfigSupported() {
    return true;
  }

  getModelName() {
    return "Firewalla Crystal";
  }

  async getWpaCliBinPath() {
    return `wpa_cli`;
  }

  async getWpaPassphraseBinPath() {
    return `wpa_passphrase`;
  }

  getMiniupnpdNftPath() {
    return `${this.getFilesPath()}/miniupnpd.nft`;
  }
}

module.exports = CrystalPlatform;
