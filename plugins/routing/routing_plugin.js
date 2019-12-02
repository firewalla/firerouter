/*    Copyright 2019 Firewalla, Inc
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

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');

const exec = require('child-process-promise').exec;
const ip = require('ip');

const pl = require('../plugin_loader.js');
const routing = require('../../util/routing.js');

class RoutingPlugin extends Plugin {
   
  async flush() {

  }

  async apply() {
    if (!this.networkConfig) {
      log.error("Network config is not configured")
      return;
    }

    switch (this.name) {
      case "global": {
        for (let type of Object.keys(this.networkConfig)) {
          const settings = this.networkConfig[type];
          switch (type) {
            case "default": {
              settings.type = settings.type || "single";
              switch (settings.type) {
                case "single": {
                  const viaIntf = settings.viaIntf;
                  const viaIntfPlugin = pl.getPluginInstance("interface", viaIntf);
                  if (viaIntfPlugin) {
                    const state = await viaIntfPlugin.state();
                    if (state && state.ip4) {
                      const cidr = ip.cidrSubnet(state.ip4);
                      await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, viaIntf, routing.RT_GLOBAL_LOCAL).catch((err) => {});
                    } else {
                      log.error("Failed to get ip4 of global default interface " + viaIntf);
                    }

                    const gw = await routing.getInterfaceGWIP(viaIntf);
                    if (gw) {
                      await routing.addRouteToTable("default", gw, viaIntf, routing.RT_GLOBAL_DEFAULT).catch((err) => {});
                    } else {
                      log.error("Failed to get gateway IP of global default interface " + viaIntf);
                    }
                  } else {
                    log.error(`Cannot find global default interface plugin ${viaIntf}`)
                  }
                  break;
                }
                case "primary_standby": {
                  break;
                }
                case "load_balance": {
                  break;
                }
              }
              break;
            }
            case "static": {
              break;
            }
            default:
              log.error(`Unsupported routing type for ${this.name}: ${type}`);
          }
        }
        break;
      }
      default: {
        for (let type of Object.keys(this.networkConfig)) {
          const settings = this.networkConfig[type];
          switch (type) {
            case "default": {
              const viaIntf = settings.viaIntf;
              const viaIntfPlugin = pl.getPluginInstance("interface", viaIntf);
              let iface = this.name;
              if (iface.includes(":")) {
                // virtual interface, need to strip suffix
                iface = this.name.substr(0, this.name.indexOf(":"));
              }
              if (viaIntfPlugin) {
                // local and default routing table accesible to the interface
                await routing.createPolicyRoutingRule("all", iface, `${viaIntf}_local`, 2001).catch((err) => {});
                await routing.createPolicyRoutingRule("all", iface, `${viaIntf}_default`, 7001).catch((err) => {});
              } else {
                log.error(`Cannot find global default interface plugin ${viaIntf}`)
              }
              break;
            }
            case "static": {
              break;
            }
            default:
              log.error(`Unsupported routing type for ${this.name}: ${type}`);
          }
        }
      }
    }
  }
}


module.exports = RoutingPlugin;