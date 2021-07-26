/*    Copyright 2021 Firewalla Inc.
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
const ncm = require('../../core/network_config_mgr')
const platform = require('../../platform/PlatformLoader').getPlatform()

const hostapdServiceFileTemplate = __dirname + "/firerouter_hostapd@.template.service";
const hostapdScript = __dirname + "/hostapd.sh";

const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter');
const fsp = require('fs').promises;

class HostapdPlugin extends Plugin {
  constructor() {
    super()

    this.config = require('./config.json')
  }

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
    let content = await fsp.readFile(hostapdServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace(/%HOSTAPD_DIRECTORY%/g, r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_hostapd@.service";
    await fsp.writeFile(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);
    await exec("sudo systemctl daemon-reload");
  }

  static async installHostapdScript() {
    await exec(`cp ${hostapdScript} ${r.getTempFolder()}/hostapd.sh`);
  }

  async flush() {
    const confPath = this._getConfFilePath();
    await exec(`sudo systemctl stop firerouter_hostapd@${this.name}`).catch((err) => {});
    await fsp.unlink(confPath).catch((err) => {});
  }

  _getConfFilePath() {
    return `${r.getUserConfigFolder()}/hostapd/${this.name}.conf`;
  }

  async apply() {
    const parameters = this.config.default ? JSON.parse(JSON.stringify(this.config.default)) : {};
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

    if (params.ht_capab && !Array.isArray(params.ht_capab)) delete params.ht_capab

    Object.assign(parameters, params)

    parameters.ht_capab = new Set(parameters.ht_capab)

    if (!parameters.channel) {
      const availableChannels = this.config.vendor[await platform.getWlanVendor()].channels

      const scores = {}
      const availableWLANs = await ncm.getWlanAvailable(this.name)
      for (const network of availableWLANs) {
        const channelConfig = this.config.channel[network.channel]
        if (!channelConfig) continue

        // ACI = Adjacent Channel Interference, this config is set to all channels being interfered
        for (const ch of channelConfig.ACI) {
          if (!scores[ch]) scores[ch] = 0
          scores[ch] += Math.pow(10, (network.signal/10)) * channelConfig.weight
        }
      }

      // print debug log
      this.log.info('channel score chart')
      Object.keys(scores).sort((a, b) => scores[a] - scores[b]).forEach(ch => this.log.info(ch, '\t', scores[ch].toFixed(15)))

      let bestChannel = undefined
      for (const ch of availableChannels) {
        if (!bestChannel || scores[bestChannel] > scores[ch])
          bestChannel = ch
      }
      this.log.info('Best channel is', bestChannel)

      parameters.channel = bestChannel
    }

    const channelConfig = this.config.channel[parameters.channel]
    if (channelConfig.ht_capab) {
      channelConfig.ht_capab.default && channelConfig.ht_capab.default.forEach(c => parameters.ht_capab.add(c))
      channelConfig.ht_capab.not && channelConfig.ht_capab.not.forEach(c => parameters.ht_capab.delete(c))
    }
    channelConfig.hw_mode && (parameters.hw_mode = channelConfig.hw_mode)
    parameters.ht_capab = '[' + Array.from(parameters.ht_capab).join('][') + ']'

    const confPath = this._getConfFilePath();
    await fsp.writeFile(confPath, Object.keys(parameters).map(k => `${k}=${parameters[k]}`).join("\n"), {encoding: 'utf8'});
    await exec(`sudo systemctl stop firerouter_hostapd@${this.name}`).catch((err) => {});
    if (this.networkConfig.enabled !== false)
      await exec(`sudo systemctl start firerouter_hostapd@${this.name}`).catch((err) => {});
  }
}

module.exports = HostapdPlugin;
