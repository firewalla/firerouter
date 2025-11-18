/*    Copyright 2025 Firewalla Inc
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

'use strict';

const WireguardInterfacePlugin = require('./wireguard_intf_plugin.js');

const exec = require('child-process-promise').exec;
const r = require('../../util/firerouter.js');
const fs = require('fs');

const platform = require('../../platform/PlatformLoader.js').getPlatform();

// const bindIntfRulePriority = 5999;

const AMNEZIAWG_NAME = 'amneziawg';
const Promise = require('bluebird');
Promise.promisifyAll(fs);

class AmneziawgInterfacePlugin extends WireguardInterfacePlugin {

  constructor(name) {
    super(name);
    this.wireguardType = AMNEZIAWG_NAME;
    this.iptablesChainName = "FR_AMNEZIA_WG";
    this.wgCmd = `${platform.getBinaryPath()}/awg`;
  }
 
  static async preparePlugin() {
    // wireguard module will help to load all dependency module
    await exec("sudo modprobe wireguard");
    await platform.installKernelModule(AMNEZIAWG_NAME);
    await exec(`mkdir -p ${r.getUserConfigFolder()}/${AMNEZIAWG_NAME}`);
  }

  isFlushNeeded(newConfig) {
    return true;
  }

  async flush() {
    await super.flush();
  }

  _getInterfaceConfPath() {
    return `${r.getUserConfigFolder()}/${this.wireguardType}/${this.name}.conf`;
  }

  getDefaultMTU() {
    // in case wireguard is 1412:
    // Obfuscation mode (H1–H4/S1–S2, etc. enabled)    +4~8 bytes
    // High obfuscation (with JC/JMIN/JMAX enabled + random padding)  +8~16 bytes
    // Leave an 8-byte safety margin to prevent PMTU ICMP anomalies.
    // 1412 - 8 - 16 - 8 = 1380
    return 1380;
  }


  _addObfuscationOptions(entries, networkConfig) {
    const obfuscationKeys = [
      'jc', 'jmin', 'jmax',
      's1', 's2',
      'h1', 'h2', 'h3', 'h4'
    ];
    for (const key of obfuscationKeys) {
      if (networkConfig[key]) {
        entries.push(`${key.toUpperCase()} = ${networkConfig[key]}`);
      }
    }
  }
}

module.exports = AmneziawgInterfacePlugin;