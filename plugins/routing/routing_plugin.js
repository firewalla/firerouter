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

const Plugin = require('../plugin.js');

const ip = require('ip');

const pl = require('../plugin_loader.js');
const routing = require('../../util/routing.js');
const event = require('../../core/event.js');

class RoutingPlugin extends Plugin {
   
  async flush() {
    if (!this.networkConfig) {
      this.log.error(`Network config for ${this.name} is not set`);
      return;
    }

    switch (this.name) {
      case "global": {
        await routing.flushRoutingTable(routing.RT_GLOBAL_LOCAL);
        await routing.flushRoutingTable(routing.RT_GLOBAL_DEFAULT);
        await routing.flushRoutingTable(routing.RT_STATIC);
        break;
      }
      default: {
        for (let type of Object.keys(this.networkConfig)) {
          const settings = this.networkConfig[type];
          switch (type) {
            case "default": {
              const viaIntf = settings.viaIntf;
              let iface = this.name;
              if (iface.includes(":")) {
                // virtual interface, need to strip suffix
                iface = this.name.substr(0, this.name.indexOf(":"));
              }
              // remove local and default routing table rule for the interface
              await routing.removePolicyRoutingRule("all", iface, `${viaIntf}_local`).catch((err) => {});
              await routing.removePolicyRoutingRule("all", iface, `${viaIntf}_default`).catch((err) => {});
              break;
            }
            case "static": {
              break;
            }
            default: {
              this.log.error(`Unsupported routing type for ${this.name}: ${type}`);
            }
          }
        }
      }
    }
  }

  async apply() {
    if (!this.networkConfig) {
      this.fatal(`Network config for ${this.name} is not set`);
      return;
    }

    switch (this.name) {
      case "global": {
        for (let type of Object.keys(this.networkConfig)) {
          const settings = this.networkConfig[type];
          switch (type) {
            case "default": {
              const defaultRoutingType = settings.type || "single";
              switch (defaultRoutingType) {
                case "single":
                case "primary_standby": {
                  const viaIntf = settings.viaIntf;
                  const viaIntfPlugin = pl.getPluginInstance("interface", viaIntf);
                  if (viaIntfPlugin) {
                    this.subscribeChangeFrom(viaIntfPlugin);
                    const state = await viaIntfPlugin.state();
                    if (state && state.ip4) {
                      const cidr = ip.cidrSubnet(state.ip4);
                      await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, viaIntf, routing.RT_GLOBAL_LOCAL).catch((err) => {});
                    } else {
                      this.log.error("Failed to get ip4 of global default interface " + viaIntf);
                    }

                    const gw = await routing.getInterfaceGWIP(viaIntf);
                    if (gw) {
                      await routing.addRouteToTable("default", gw, viaIntf, routing.RT_GLOBAL_DEFAULT).catch((err) => {});
                      // replace default gateway in main routing table
                      await routing.removeRouteFromTable("default", null, null, null).catch((err) => {});
                      await routing.addRouteToTable("default", gw, viaIntf, "main").catch((err) => {});
                    } else {
                      this.log.error("Failed to get gateway IP of global default interface " + viaIntf);
                    }
                  } else {
                    this.fatal(`Cannot find global default interface plugin ${viaIntf}`);
                  }

                  if (defaultRoutingType !== "primary_standby")
                    break;
                  // TODO: Add auto recovery for primary default route
                  const viaIntf2 = settings.viaIntf2;
                  const viaIntf2Plugin = pl.getPluginInstance("interface", viaIntf2);
                  if (viaIntf2Plugin) {
                    this.subscribeChangeFrom(viaIntf2Plugin);
                    const state = await viaIntf2Plugin.state();
                    if (state && state.ip4) {
                      const cidr = ip.cidrSubnet(state.ip4);
                      await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, viaIntf2, routing.RT_GLOBAL_LOCAL, 100).catch((err) => { });
                    } else {
                      this.log.error("Failed to get ip4 of global default interface " + viaIntf2);
                    }

                    const gw = await routing.getInterfaceGWIP(viaIntf2);
                    if (gw) {
                      await routing.addRouteToTable("default", gw, viaIntf2, routing.RT_GLOBAL_DEFAULT, 100).catch((err) => { });
                      await routing.addRouteToTable("default", gw, viaIntf2, "main", 100).catch((err) => { });
                    } else {
                      this.log.error("Failed to get gateway IP of global default interface " + viaIntf2);
                    }
                  } else {
                    this.fatal(`Cannot find global default interface plugin ${viaIntf2}`);
                  }   
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
              this.log.error(`Unsupported routing type for ${this.name}: ${type}`);
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
                this.subscribeChangeFrom(viaIntfPlugin);
                // local and default routing table accesible to the interface
                await routing.createPolicyRoutingRule("all", iface, `${viaIntf}_local`, 2001);
                await routing.createPolicyRoutingRule("all", iface, `${viaIntf}_default`, 7001);
              } else {
                this.fatal(`Cannot find global default interface plugin ${viaIntf}`)
              }
              break;
            }
            case "static": {
              break;
            }
            default:
              this.log.error(`Unsupported routing type for ${this.name}: ${type}`);
          }
        }
      }
    }
  }

  onEvent(e) {
    this.log.info("Received event", e);
    const eventType = event.getEventType(e);
    switch (eventType) {
      case event.EVENT_IP_CHANGE: {
        this._reapplyNeeded = true;
        pl.scheduleReapply();
        break;
      }
      default:
    }
  }
}


module.exports = RoutingPlugin;