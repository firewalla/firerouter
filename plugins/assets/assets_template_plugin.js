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

const Plugin = require('../plugin.js');
const exec = require('child-process-promise').exec;
const pl = require('../plugin_loader.js');
const r = require('../../util/firerouter.js');
const _ = require('lodash');
const util = require('../../util/util.js');
const crypto = require('crypto');

const AssetsController = require('../../core/assets_controller.js');

class AssetsTemplatePlugin extends Plugin {
  async flush() {

  }

  async apply() {
    const config = this.networkConfig;
    // subscription chain will be established in generateEffectiveConfig
    await this.generateEffectiveConfig(config);
  }

  async generateEffectiveConfig(config) {
    const effectiveConfig = {};
    for (const key of Object.keys(config)) {
      switch (key) {
        case "wifiNetworks": {
          /*
            [
              {
                "intf": "br0",
                "management": true,
                "vlanUntag": false,
                "ssidProfiles": ["ssid_2.4g", "ssid_5g"]
              }
            ]
          */
          if (!_.isArray(config[key])) {
            this.fatal(`"wifiNetworks" in asset config should be an array`);
          }
          effectiveConfig.wifiNetworks = [];
          for (const network of config[key])
            effectiveConfig.wifiNetworks.push(await this.convertWifiNetworkConfig(network));
          if (effectiveConfig.wifiNetworks.filter(n => !n.hasOwnProperty("vlan")).length > 1)
            this.fatal(`More than 1 untagged network is set in "wifiNetworks" of asset ${uid}`);
          // need to dynamically calculate channels
          if (!effectiveConfig.channel5g)
            effectiveConfig.channel5g = "auto";
          if (!effectiveConfig.channel24g)
            effectiveConfig.channel24g = "auto";
          break;
        }
        default:
          effectiveConfig[key] = config[key];
      }
    }
    return effectiveConfig;
  }

  async convertWifiNetworkConfig(wifiNetworkConfig) {
    if (!wifiNetworkConfig.ssidProfiles)
      this.fatal(`ssidProfiles is not defined in wifiNetwork config on ${this.name}`);
    const wifiConfig = {ssids: []};
    let vlanIntf = null;
    let vlanOverride = null;
    let vlanUntag = false;
    for (const key of Object.keys(wifiNetworkConfig)) {
      const value = wifiNetworkConfig[key];
      switch (key) {
        case "intf": {
          // derive vlan from intf
          const intfPlugin = pl.getPluginInstance("interface", value);
          if (!intfPlugin)
            this.fatal(`"intf" ${value} is not found in config`);
          this.subscribeChangeFrom(intfPlugin);
          const ip4s = await intfPlugin.getIPv4Addresses();
          if (!_.isEmpty(ip4s))
            wifiConfig.ipv4Hint = ip4s[0];
          switch (intfPlugin.constructor.name) {
            case "VLANInterfacePlugin":
              vlanIntf = intfPlugin.networkConfig.vid;
              break;
            case "BridgeInterfacePlugin":
              for (const intf of intfPlugin.networkConfig.intf) {
                const plugin = pl.getPluginInstance("interface", intf);
                if (plugin && plugin.constructor.name === "VLANInterfacePlugin") {
                  vlanIntf = plugin.networkConfig.vid;
                  break;
                }
              }
              break;
          }
          break;
        }
        case "vlan": {
          // vlan derived from intf can be overridden in config
          vlanOverride = value;
          break;
        }
        case "vlanUntag": {
          // remove vlan id if vlanUntag is specified
          vlanUntag = value;
          break;
        }
        case "ssidProfiles": {
          if (!_.isArray(value))
            this.fatal(`ssidProfiles in wifiNetworks of ${this.name} is not an array`);
          for (const ssidProfile of value) {
            const profilePlugin = pl.getPluginInstance("profile", ssidProfile);
            if (!profilePlugin)
              this.fatal(`ssid profile ${ssidProfile} is not found`);
            this.subscribeChangeFrom(profilePlugin);
            const profile = profilePlugin.networkConfig;
            const ssidCommonConfig = {};
            Object.assign(ssidCommonConfig, _.pick(profile, ["ssid", "enterprise", "hidden", "isolate", "hints", "radius"]));

            // refer to https://openwrt.org/docs/guide-user/network/wifi/basic#encryption_modes
            switch (profile.encryption) {
              case "enterprise":
                switch (profile.wpa) {
                  case "3":
                    ssidCommonConfig.encryption = "wpa3";
                    break;
                  case "2/3":
                    ssidCommonConfig.encryption = "wpa3-mixed";
                    break;
                  default:
                    ssidCommonConfig.encryption = "wpa2";
                }
                break;
              case "open":
                ssidCommonConfig.encryption = "none";
                break;
              case "enhancedOpen":
                ssidCommonConfig.encryption = "owe";
                break;
              default:
              // FIXME: fix this to the right config once the right AP settings are figured out
              // before that comment this code out
              // default encryption on fwap code side is psk2+ccmp
                // switch (profile.wpa) {
                //   case "3":
                //     ssidCommonConfig.encryption = "sae";
                //     break;
                //   case "2/3":
                //     ssidCommonConfig.encryption = "sae-mixed";
                //     break;
                //   default:
                //     ssidCommonConfig.encryption = "psk2";
                // }
            }

            // FIXME: do not generate PSK for radius network, due to AP config limitation
            if (profile.radius) {
              ssidCommonConfig.key = profile.key;
            // FIXME: do not generate PSK for wpa3 network, due to AP config limitation
            } else if (profile.key && ! ["3", "2/3"].includes(profile.wpa)) {
              ssidCommonConfig.key = await util.generatePSK(profile.ssid, profile.key);
            } else {
              ssidCommonConfig.key = profile.key;
            }

            // randomize options for fast roaming
            const ftSeed24 = await this.calculateFTSeed(wifiNetworkConfig.intf || "", ssidProfile, "2.4g");
            const ftSeed5 = await this.calculateFTSeed(wifiNetworkConfig.intf || "", ssidProfile, "5g");
            const ftSeed6 = await this.calculateFTSeed(wifiNetworkConfig.intf || "", ssidProfile, "6g");
            const mdId24 = ftSeed24.substring(ftSeed24.length - 4);
            const mdId5 = ftSeed5.substring(ftSeed5.length - 4);
            const mdId6 = ftSeed6.substring(ftSeed6.length - 4);
            const nasId24 = ftSeed24.substring(0, 16);
            const nasId5 = ftSeed5.substring(0, 16);
            const nasId6 = ftSeed6.substring(0, 16);
            const khKeyHex24 = ftSeed24.substring(16, 48);
            const khKeyHex5 = ftSeed5.substring(16, 48);
            const khKeyHex6 = ftSeed6.substring(16, 48);
            switch (profile.band) {
              // need an adaptive way to select channel
              case "2.4g":
                wifiConfig.ssids.push(Object.assign({}, ssidCommonConfig, {band: "2.4g", ft: {nasId: nasId24, mobilityDomain: mdId24, khKeyHex: khKeyHex24}}));
                break;
              case "5g":
                wifiConfig.ssids.push(Object.assign({}, ssidCommonConfig, {band: "5g", ft: {nasId: nasId5, mobilityDomain: mdId5, khKeyHex: khKeyHex5}}));
                break;
              case "6g":
                wifiConfig.ssids.push(Object.assign({}, ssidCommonConfig, {band: "6g", ft: {nasId: nasId6, mobilityDomain: mdId6, khKeyHex: khKeyHex6}}));
                break;
              case "2.4g+5g+6g":
                wifiConfig.ssids.push(Object.assign({}, ssidCommonConfig, {band: "2.4g", ft: {nasId: nasId24, mobilityDomain: mdId24, khKeyHex: khKeyHex24}}));
                wifiConfig.ssids.push(Object.assign({}, ssidCommonConfig, {band: "5g", ft: {nasId: nasId5, mobilityDomain: mdId5, khKeyHex: khKeyHex5}}));
                wifiConfig.ssids.push(Object.assign({}, ssidCommonConfig, {band: "6g", ft: {nasId: nasId6, mobilityDomain: mdId6, khKeyHex: khKeyHex6}}));
                break;
              default:
                wifiConfig.ssids.push(Object.assign({}, ssidCommonConfig, {band: "2.4g", ft: {nasId: nasId24, mobilityDomain: mdId24, khKeyHex: khKeyHex24}}));
                wifiConfig.ssids.push(Object.assign({}, ssidCommonConfig, {band: "5g", ft: {nasId: nasId5, mobilityDomain: mdId5, khKeyHex: khKeyHex5}}));
            }
          }
          break;
        }
        default: {
          wifiConfig[key] = value;
        }
      } 
    }

    if (!vlanUntag) {
      if (vlanOverride || vlanIntf)
        wifiConfig.vlan = vlanOverride || vlanIntf;
    }
    return wifiConfig;
  }

  async calculateFTSeed(intf, profileId, band) {
    const controllerID = await AssetsController.getControllerID();
    return crypto.createHash('sha256').update(`${controllerID}::${intf}::${profileId}::${band}`).digest('hex');
  }
}

module.exports = AssetsTemplatePlugin;
