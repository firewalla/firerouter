/*    Copyright 2021 Firewalla Inc
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

const Plugin = require('../plugin.js');
const pl = require('../plugin_loader.js');

const hostapdServiceFileTemplate = __dirname + "/firerouter_hostapd@.template.service";
const hostapdScript = __dirname + "/hostapd.sh";

const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

class HostapdPlugin extends Plugin {

  static async preparePlugin() {
    await this.createDirectories();
    await this.installHostapdScript();
    await this.installSystemService();
  }

  static async createDirectories() {
    await exec(`mkdir -p ${r.getUserConfigFolder()}/hostapd`).catch((err) => {});
    await exec(`mkdir -p ${r.getTempFolder()}`).catch((err) => {});
  } 

  static async installSystemService() {
    let content = await fs.readFileAsync(hostapdServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace(/%HOSTAPD_DIRECTORY%/g, r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_hostapd@.service";
    await fs.writeFileAsync(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);
    await exec("sudo systemctl daemon-reload");
  }

  static async installHostapdScript() {
    await exec(`cp ${hostapdScript} ${r.getTempFolder()}/hostapd.sh`);
  }

  async flush() {
    const confPath = this._getConfFilePath();
    await exec(`sudo systemctl stop firerouter_hostapd@${this.name}`).catch((err) => {});
    await fs.unlinkAsync(confPath).catch((err) => {});
  }

  _getConfFilePath() {
    return `${r.getUserConfigFolder()}/hostapd/${this.name}.conf`;
  }

  async apply() {
    const parameters = {};
    const params = this.networkConfig.params || {};
    parameters.interface = this.name;
    const intfPlugin = pl.getPluginInstance("interface", this.name);
    if (!intfPlugin)
      this.fatal(`Cannot find interface plugin ${this.name}`);
    this.subscribeChangeFrom(intfPlugin);
    if (this.networkConfig.bridge) {
      const bridgeIntfPlugin = pl.getPluginInstance("interface", this.networkConfig.bridge);
      if (!bridgeIntfPlugin)
        this.fatal(`Cannot find bridge interface plugin ${this.networkConfig.bridge}`);
      this.subscribeChangeFrom(bridgeIntfPlugin);
      if (await bridgeIntfPlugin.isInterfacePresent() === false) {
        this.log.warn(`Bridge interface ${this.networkConfig.bridge} is not present yet`);
        return;
      }
      parameters.bridge = this.networkConfig.bridge;  
    }

    for (const key of Object.keys(params))
      parameters[key] = params[key];

    const confPath = this._getConfFilePath();
    await fs.writeFileAsync(confPath, Object.keys(parameters).map(k => `${k}=${parameters[k]}`).join("\n"), {encoding: 'utf8'});
    await exec(`sudo systemctl stop firerouter_hostapd@${this.name}`).catch((err) => {});
    if (this.networkConfig.enabled !== false)
      await exec(`sudo systemctl start firerouter_hostapd@${this.name}`).catch((err) => {});
  }
}

module.exports = HostapdPlugin;