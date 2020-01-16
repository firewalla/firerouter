/*    Copyright 2019 Firewalla Inc
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

const InterfaceBasePlugin = require('./intf_base_plugin.js');

const exec = require('child-process-promise').exec;
const r = require('../../util/firerouter.js');
const fs = require('fs');
const Promise = require('bluebird');
const pl = require('../plugin_loader.js');
Promise.promisifyAll(fs);

const pppoeTemplateFilePath = `${r.getFireRouterHome()}/etc/ppp.conf.template`

class PPPoEInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    const pppIpUpScriptPath = `${r.getFireRouterHome()}/scripts/ppp_ip_up`;
    await exec(`sudo rm /etc/ppp/ip-up.d/*`).catch((err) => {});
    await exec(`sudo cp ${pppIpUpScriptPath} /etc/ppp/ip-up.d/`).catch((err) => {});
    await exec(`mkdir -p ${r.getUserConfigFolder()}/pppoe`).catch((err) => {});
  }

  _getPPPDPidFilePath() {
    return `/run/ppp-${this.name}.pid`;
  }

  async flushIP() {
    await exec(`cat ${this._getPPPDPidFilePath()}`).then((result) => exec(`sudo kill -9 ${result.stdout.trim()}`)).catch((err) => {});
    await exec(`rm -f ${this._getConfFilePath()}`).catch((err) => {});
  }

  async isWAN() {
    return true;
  }

  async isLAN() {
    return false;
  }

  _getConfFilePath() {
    return `${r.getUserConfigFolder()}/pppoe/${this.name}.conf`;
  }

  _getResolvConfFilePath() {
    return `/etc/ppp/${this.name}.resolv.conf`
  }

  async createInterface() {
    // create config file instead
    if (!this.networkConfig || !this.networkConfig.username || !this.networkConfig.password) {
      this.log.error("username or password is not specified for pppoe", this.name);
      return;
    }
    let config = await fs.readFileAsync(pppoeTemplateFilePath, {encoding: "utf8"});
    const username = this.networkConfig.username;
    const password = this.networkConfig.password;
    const intf = this.networkConfig.intf;
    const mru = this.networkConfig.mru || 1492;
    const mtu = this.networkConfig.mtu || 1492;
    const linkname = this.name;
    config = config.replace("#USERNAME#", username)
      .replace("#PASSWORD#", password)
      .replace("#INTF#", intf)
      .replace("#MRU#", mru)
      .replace("#MTU#", mtu)
      .replace("#LINKNAME#", linkname);
    const intfPlugin = pl.getPluginInstance("interface", intf);
    if (intfPlugin) {
      this.subscribeChangeFrom(intfPlugin);
      await fs.writeFileAsync(this._getConfFilePath(), config);
    } else {
      this.fatal(`Failed to find interface plugin ${intf}`);
    }
  }

  async interfaceUpDown() {
    if (this.networkConfig.enabled) {
      await exec(`sudo pppd file ${this._getConfFilePath()}`);
    } else {
      await exec(`cat ${this._getPPPDPidFilePath()}`).then((result) => exec(`sudo kill -9 ${result.stdout.trim()}`)).catch((err) => {});
    }
  }

  async applyIpDnsSettings() {
    await fs.accessAsync(r.getInterfaceResolvConfPath(this.name), fs.constants.F_OK).then(() => {
      this.log.info(`Remove old resolv conf for ${this.name}`);
      return fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name));
    }).catch((err) => {});
    await fs.symlinkAsync(this._getResolvConfFilePath(), r.getInterfaceResolvConfPath(this.name));
  }
}

module.exports = PPPoEInterfacePlugin;