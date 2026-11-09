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

const AMNEZIAWG_MODULE_NAME = 'amneziawg';
const SYSTEM_AWG_BIN_PATH = '/usr/bin/awg';

class CrystalPlatform extends Platform {
  getName() {
    return "crystal";
  }

  async resolveAwgBinPath() {
    const systemModuleLoaded = await this.isSystemAwgModuleLoaded();
    if (systemModuleLoaded && fs.existsSync(SYSTEM_AWG_BIN_PATH)) {
      this.awgBinPath = SYSTEM_AWG_BIN_PATH;
      return;
    }
    this.awgBinPath = super.getAwgBinPath();
  }

  async isSystemAwgModuleLoaded() {
    const systemSrcVersion = await this.getModuleSrcVersion(AMNEZIAWG_MODULE_NAME);
    if (!systemSrcVersion) {
      return false;
    }
    const loadedSrcVersion = await this.getLoadedModuleSrcVersion(AMNEZIAWG_MODULE_NAME);
    return loadedSrcVersion === systemSrcVersion;
  }

  getAwgBinPath() {
    return this.awgBinPath || super.getAwgBinPath();
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
