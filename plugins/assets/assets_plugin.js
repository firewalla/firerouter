/*    Copyright 2023 Firewalla Inc
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

const AssetsTemplatePlugin = require('./assets_template_plugin.js');
const pl = require('../plugin_loader.js');
const { Address4 } = require('ip-address');

const AssetsController = require('../../core/assets_controller.js');

class AssetsPlugin extends AssetsTemplatePlugin {
  async flush() {
    await super.flush();
    const uid = this.name;
    await AssetsController.deleteEffectiveConfig(uid);
  }

  async apply() {
    const uid = this.name;
    const config = this.networkConfig;
    if (config.templateId) {
      const templatePlugin = pl.getPluginInstance("assets_template", config.templateId);
      if (!templatePlugin)
        this.fatal(`Cannot find assets template ${config.templateId}`);
      this.subscribeChangeFrom(templatePlugin);
      // keys in config can overwrite keys in template
      const mergedConfig = Object.assign({}, templatePlugin.networkConfig, config);
      delete mergedConfig.templateId;
      this.log.info(`Asset ${uid} will use merged config`, mergedConfig);
      const effectiveConfig = await this.generateEffectiveConfig(mergedConfig);
      await AssetsController.setEffectiveConfig(uid, effectiveConfig);
    } else {
      const effectiveConfig = await this.generateEffectiveConfig(config);
      await AssetsController.setEffectiveConfig(uid, effectiveConfig);
    }
  }

  async validateIP(assetIP, effectiveConfig) {
    const addr4 = new Address4(assetIP);
    if (!addr4.isValid())
      return;
    for (const key of Object.keys(effectiveConfig)) {
      switch (key) {
        case "wifiNetworks": {
          
          
          break;
        }
        default:
      }
    }
  }
}

module.exports = AssetsPlugin;