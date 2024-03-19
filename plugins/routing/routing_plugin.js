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

const pl = require('../plugin_loader.js');
const routing = require('../../util/routing.js');
const event = require('../../core/event.js');
const Message = require('../../core/Message.js');
const {Address4, Address6} = require('ip-address');
const AsyncLock = require('async-lock');
const LOCK_APPLY_ACTIVE_WAN = "LOCK_APPLY_ACTIVE_WAN";
const LOCK_SHARED = "LOCK_SHARED";
const lock = new AsyncLock();
const _ = require('lodash');
const pclient = require('../../util/redis_manager.js').getPublishClient();
const wrapIptables = require('../../util/util.js').wrapIptables;
const exec = require('child-process-promise').exec;
const PlatformLoader = require('../../platform/PlatformLoader.js');
const platform = PlatformLoader.getPlatform();
const WireguardInterfacePlugin = require('../interface/wireguard_intf_plugin.js');

class RoutingPlugin extends Plugin {

  static async preparePlugin() {
    // ensure ip forward is enabled
    await exec(`sudo sysctl -w net.ipv4.ip_forward=1`).catch((err) => {});
    await exec(`sudo sysctl -w net.ipv6.conf.all.forwarding=1`).catch((err) => {});
  }
   
  async flush(af = null) {
    if (!this.networkConfig) {
      this.log.error(`Network config for ${this.name} is not set`);
      return;
    }
    await lock.acquire(LOCK_SHARED, async () => {
      this._wanStatus = this._wanStatus || {};
      await this._flushOutputSNATRules(af);

      switch (this.name) {
        case "global": {
          await routing.flushRoutingTable(routing.RT_GLOBAL_LOCAL, af);
          await routing.flushRoutingTable(routing.RT_GLOBAL_DEFAULT, af);
          await routing.flushRoutingTable(routing.RT_STATIC, af);
          // remove all default route in main table
          let routeRemoved = false;
          if (!af || af == 4) {
            do {
              await routing.removeRouteFromTable("default", null, null, "main").then(() => {
                routeRemoved = true;
              }).catch((err) => {
                routeRemoved = false;
              });
            } while (routeRemoved);
          }

          if (!af || af == 6) {
            do {
              await routing.removeRouteFromTable("default", null, null, "main", 6).then(() => {
                routeRemoved = true;
              }).catch((err) => {
                routeRemoved = false;
              });
            } while (routeRemoved);
          }
          if (!af || af == 4) {
            // remove DNS specific routes
            if (_.isArray(this._dnsRoutes)) {
              for (const dnsRoute of this._dnsRoutes)
                await routing.removeRouteFromTable(dnsRoute.dest, dnsRoute.gw, dnsRoute.viaIntf, "main", 4).catch((err) => { });
            }
            this._dnsRoutes = [];
          }
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
                if (!af || af == 4) {
                  await routing.removePolicyRoutingRule("all", iface, `${viaIntf}_local`, 2001).catch((err) => {});
                  await routing.removePolicyRoutingRule("all", iface, `${viaIntf}_default`, 7001).catch((err) => {});
                }
                if (!af || af == 6) {
                  await routing.removePolicyRoutingRule("all", iface, `${viaIntf}_local`, 2001, null, 6).catch((err) => {});
                  await routing.removePolicyRoutingRule("all", iface, `${viaIntf}_default`, 7001, null, 6).catch((err) => {});
                }
                break;
              }
              case "static": {
                await routing.flushRoutingTable(`${this.name}_static`, af).catch((err) => {});
                break;
              }
              default: {
                this.log.error(`Unsupported routing type for ${this.name}: ${type}`);
              }
            }
          }
        }
      }
    });
  }

  async _flushOutputSNATRules(af = null) {
    if (!af || af == 4)
      await exec(wrapIptables(`sudo iptables -w -t nat -F FR_OUTPUT_SNAT`)).catch((err) => {});
    if (!af || af == 6)
      await exec(wrapIptables(`sudo ip6tables -w -t nat -F FR_OUTPUT_SNAT`)).catch((err) => {});
  }

  async _refreshOutputSNATRules(af = null) {
    await this._flushOutputSNATRules(af);
    if (af && af != 4)
      return;
    for (const srcIntf of Object.keys(this._wanStatus)) {
      const srcIntfPlugin = this._wanStatus[srcIntf].plugin;
      const state = await srcIntfPlugin.state();
      if (state && state.ip4s) {
        for (const ip4 of state.ip4s) {
          const ip4Addr = ip4.split('/')[0];
          for (const dstIntf of Object.keys(this._wanStatus)) {
            if (dstIntf !== srcIntf) {
              await exec(wrapIptables(`sudo iptables -t nat -A FR_OUTPUT_SNAT -s ${ip4Addr} -o ${dstIntf} -j MASQUERADE`)).catch((err) => {
                this.log.error(`Failed to add output SNAT rule from ${ip4Addr} to ${dstIntf}`, err.message);
              });
            }
          }
        }
      }
    }
  }

  meterApplyActiveGlobalDefaultRouting() {
    const now = new Date();

    if(this.lastApplyTimestamp) {
      const diff = Math.floor(now / 1000 - this.lastApplyTimestamp / 1000);
      this.log.info(`applying active global default routing, ${diff} seconds since last time apply`);
    } else {
      this.log.info(`applying active global default routing, first time since firerouter starting up`);
    }

    this.lastApplyTimestamp = now;
  }

  async _applyActiveGlobalDefaultRouting(inAsyncContext = false, af = null) {
    this.meterApplyActiveGlobalDefaultRouting();
    // async context and apply/flush context should be mutually exclusive, so they acquire the same LOCK_SHARED
    await lock.acquire(inAsyncContext ? LOCK_SHARED : LOCK_APPLY_ACTIVE_WAN, async () => {
      // flush global default routing table, no need to touch global static routing table here
      await routing.flushRoutingTable(routing.RT_GLOBAL_DEFAULT, af);
      await routing.flushRoutingTable(routing.RT_GLOBAL_LOCAL, af);
      // remove all default route in main table
      let routeRemoved = false;
      if (!af || af == 4) {
        do {
          await routing.removeRouteFromTable("default", null, null, "main").then(() => {
            routeRemoved = true;
          }).catch((err) => {
            routeRemoved = false;
          });
        } while (routeRemoved)
      }

      if (!af || af == 6) {
        do {
          await routing.removeRouteFromTable("default", null, null, "main", 6).then(() => {
            routeRemoved = true;
          }).catch((err) => {
            routeRemoved = false;
          });
        } while (routeRemoved)
      }
      if (!af || af == 4) {
        // remove DNS specific routes
        if (_.isArray(this._dnsRoutes)) {
          for (const dnsRoute of this._dnsRoutes)
            await routing.removeRouteFromTable(dnsRoute.dest, dnsRoute.gw, dnsRoute.viaIntf, "main", 4).catch((err) => { });
        }
        this._dnsRoutes = [];
      }
      const type = this.networkConfig.default.type || "single";
      switch (type) {
        case "single":
        case "primary_standby": {
          let activeIntfFound = false;
          for (const viaIntf of Object.keys(this._wanStatus).sort((i, j) => this._wanStatus[i].seq - this._wanStatus[j].seq)) { // sort by seq in ascending order
            const viaIntfPlugin = this._wanStatus[viaIntf].plugin;
            const state = await viaIntfPlugin.state();
            const ready = this._wanStatus[viaIntf].ready;
            this._wanStatus[viaIntf].active = ready && !activeIntfFound;
            if (this._wanStatus[viaIntf].active === true)
              activeIntfFound = true;
            // set a much lower priority for inactive WAN, the minimal metric will be 1 because settings metric to 0 in ipv6 will result in metric falling back to 1024
            const metric = this._wanStatus[viaIntf].seq + 1 + (ready ? 0 : 100);
            if (!af || af == 4) {
              if (state && state.ip4s) {
                for (const ip4 of state.ip4s) {
                  const addr = new Address4(ip4);
                  const networkAddr = addr.startAddress();
                  const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
                  await routing.addRouteToTable(cidr, null, viaIntf, routing.RT_GLOBAL_LOCAL, metric).catch((err) => { });
                  await routing.addRouteToTable(cidr, null, viaIntf, routing.RT_GLOBAL_DEFAULT, metric).catch((err) => { });
                }
              } else {
                this.log.error("Failed to get ip4 of global default interface " + viaIntf);
              }
            }
            if (!af || af == 6) {
              if (state && state.ip6) {
                for (const ip6Addr of state.ip6) {
                  const addr = new Address6(ip6Addr);
                  const networkAddr = addr.startAddress();
                  const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
                  await routing.addRouteToTable(cidr, null, viaIntf, routing.RT_GLOBAL_LOCAL, metric, 6).catch((err) => { });
                  await routing.addRouteToTable(cidr, null, viaIntf, routing.RT_GLOBAL_DEFAULT, metric, 6).catch((err) => { });
                }
              } else {
                this.log.info("No ip6 found on global default interface " + viaIntf);
              }
            }

            const gw = await routing.getInterfaceGWIP(viaIntf);
            if (!af || af == 4) {
              if (gw) { // IPv4 default route for inactive WAN is still required for WAN connectivity check
                await routing.addRouteToTable("default", gw, viaIntf, routing.RT_GLOBAL_DEFAULT, metric, 4).catch((err) => { });
                await routing.addRouteToTable("default", gw, viaIntf, "main", metric, 4).catch((err) => { });
                // add route for DNS nameserver IP in global_default table
                const dns = await viaIntfPlugin.getDNSNameservers();
                if (_.isArray(dns) && dns.length !== 0) {
                  for (const dnsIP of dns) {
                    await routing.addRouteToTable(dnsIP, gw, viaIntf, routing.RT_GLOBAL_DEFAULT, metric, 4, true).catch((err) => {
                      this.log.error(`Failed to add route to ${routing.RT_GLOBAL_DEFAULT} for dns ${dnsIP} via ${gw} dev ${viaIntf}`, err.message);
                    });
                    let dnsRouteRemoved = false;
                    // remove all dns routes via the same interface but with different metrics in main table
                    do {
                      await routing.removeRouteFromTable(dnsIP, gw, viaIntf, "main").then(() => {
                        dnsRouteRemoved = true;
                      }).catch((err) => {
                        dnsRouteRemoved = false;
                      })
                    } while (dnsRouteRemoved)
                    await routing.addRouteToTable(dnsIP, gw, viaIntf, "main", metric, 4, true).catch((err) => {
                      this.log.error(`Failed to add route to main for dns ${dnsIP} via ${gw} dev ${viaIntf}`, err.message);
                    });
                    this._dnsRoutes.push({dest: dnsIP, gw: gw, viaIntf: viaIntf, metric: metric});
                  }
                }
              } else {
                this.log.error("Failed to get gateway IP of global default interface " + viaIntf);
              }
            }
            const gw6 = await routing.getInterfaceGWIP(viaIntf, 6);
            if (!af || af == 6) {
              if (gw6 && (ready || type === "single")) { // do not add IPv6 default route for inactive WAN under dual WAN setup, WAN connectivity check only uses IPv4
                await routing.addRouteToTable("default", gw6, viaIntf, routing.RT_GLOBAL_DEFAULT, metric, 6).catch((err) => { });
                await routing.addRouteToTable("default", gw6, viaIntf, "main", metric, 6).catch((err) => { });
              } else {
                this.log.info("IPv6 gateway is not defined on global default interface " + viaIntf);
              }
            }
          }
          break;
        }
        case "load_balance": {
          const multiPathDesc = [];
          const multiPathDesc6 = [];
          for (const viaIntf of Object.keys(this._wanStatus)) {
            const viaIntfPlugin = this._wanStatus[viaIntf].plugin;
            const ready = this._wanStatus[viaIntf].ready;
            const weight = this._wanStatus[viaIntf].weight || 50;
            const state = await viaIntfPlugin.state();
            this._wanStatus[viaIntf].active = ready;
            const metric = this._wanStatus[viaIntf].seq + 1 + (ready ? 0 : 100);
            if (!af || af == 4) {
              if (state && state.ip4s) {
                for (const ip4 of state.ip4s) {
                  const addr = new Address4(ip4);
                  const networkAddr = addr.startAddress();
                  const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
                  await routing.addRouteToTable(cidr, null, viaIntf, routing.RT_GLOBAL_LOCAL, metric).catch((err) => { });
                  await routing.addRouteToTable(cidr, null, viaIntf, routing.RT_GLOBAL_DEFAULT, metric).catch((err) => { });
                }
              } else {
                this.log.error("Failed to get ip4 of global default interface " + viaIntf);
              }
            }
            if (!af || af == 6) {
              if (state && state.ip6) {
                for (const ip6Addr of state.ip6) {
                  const addr = new Address6(ip6Addr);
                  const networkAddr = addr.startAddress();
                  const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
                  await routing.addRouteToTable(cidr, null, viaIntf, routing.RT_GLOBAL_LOCAL, metric, 6).catch((err) => { });
                  await routing.addRouteToTable(cidr, null, viaIntf, routing.RT_GLOBAL_DEFAULT, metric, 6).catch((err) => { });
                }
              } else {
                this.log.info("No ip6 found on global default interface " + viaIntf);
              }
            }
            const gw = await routing.getInterfaceGWIP(viaIntf);
            const gw6 = await routing.getInterfaceGWIP(viaIntf, 6);
            if (!af || af == 4) {
              if (gw) {
                // add a default route with higher metric if it is inactive. A default route is needed for WAN connectivity check, e.g., ping -I eth0 1.1.1.1
                if (ready) {
                  multiPathDesc.push({ nextHop: gw, dev: viaIntf, weight: weight });
                } else {
                  await routing.addRouteToTable("default", gw, viaIntf, routing.RT_GLOBAL_DEFAULT, metric, 4).catch((err) => { });
                  await routing.addRouteToTable("default", gw, viaIntf, "main", metric, 4).catch((err) => { });
                }
                // add route for DNS nameserver IP in global_default table
                const dns = await viaIntfPlugin.getDNSNameservers();
                if (_.isArray(dns) && dns.length !== 0) {
                  for (const dnsIP of dns) {
                    await routing.addRouteToTable(dnsIP, gw, viaIntf, routing.RT_GLOBAL_DEFAULT, metric, 4, true).catch((err) => {
                      this.log.error(`Failed to add route to ${routing.RT_GLOBAL_DEFAULT} for dns ${dnsIP} via ${gw} dev ${viaIntf}`, err.message);
                    });
                    let dnsRouteRemoved = false;
                    // remove all dns routes via the same interface but with different metrics in main table
                    do {
                      await routing.removeRouteFromTable(dnsIP, gw, viaIntf, "main").then(() => {
                        dnsRouteRemoved = true;
                      }).catch((err) => {
                        dnsRouteRemoved = false;
                      })
                    } while (dnsRouteRemoved)
                    await routing.addRouteToTable(dnsIP, gw, viaIntf, "main", metric, 4, true).catch((err) => {
                      this.log.error(`Failed to add route to main for dns ${dnsIP} via ${gw} dev ${viaIntf}`, err.message);
                    });
                    this._dnsRoutes.push({dest: dnsIP, gw: gw, viaIntf: viaIntf, metric: metric});
                  }
                }
              } else {
                this.log.error("Failed to get IPv4 gateway of global default interface " + viaIntf);
              }
            }

            if (!af || af == 6) {
              if (gw6) {
                if (ready) {
                  multiPathDesc6.push({ nextHop: gw6, dev: viaIntf, weight: weight });
                } else {
                  // do not add IPv6 default route for inactive WAN, WAN connectivity check only uses IPv4
                  /*
                  const metric = this._wanStatus[viaIntf].seq + 100;
                  await routing.addRouteToTable("default", gw6, viaIntf, routing.RT_GLOBAL_DEFAULT, metric, 6).catch((err) => { });
                  await routing.addRouteToTable("default", gw6, viaIntf, "main", metric, 6).catch((err) => { });
                  */
                }
              } else {
                this.log.info("Failed to get IPv6 gateway of global default interface " + viaIntf);
              }
            }
          }
          if (multiPathDesc.length > 0) {
            await routing.addMultiPathRouteToTable("default", routing.RT_GLOBAL_DEFAULT, 4, ...multiPathDesc).catch((err) => { });
            await routing.addMultiPathRouteToTable("default", "main", 4, ...multiPathDesc).catch((err) => { });
          }
          if (multiPathDesc6.length > 0) {
            await routing.addMultiPathRouteToTable("default", routing.RT_GLOBAL_DEFAULT, 6, ...multiPathDesc6).catch((err) => { });
            await routing.addMultiPathRouteToTable("default", "main", 6, ...multiPathDesc6).catch((err) => { });
          }
          break;
        }
        default:
      }
      await this._refreshOutputSNATRules(af);
      this.processWANConnChange(); // no need to await, call this func again to ensure led is set correctly
    });
  }

  async apply() {
    if (!this.networkConfig) {
      this.fatal(`Network config for ${this.name} is not set`);
      return;
    }
    await lock.acquire(LOCK_SHARED, async () => {
      const lastWanStatus = this._wanStatus || {};
      if (!this._wanStatus)
        this._wanStatus = {};
      this._pendingChangeDescs = this._pendingChangeDescs || [];
      const wanStatus = {};

      switch (this.name) {
        case "global": {
          for (let type of Object.keys(this.networkConfig)) {
            const settings = this.networkConfig[type];
            switch (type) {
              case "default": {
                const defaultRoutingType = settings.type || "single";
                let changeDescs = [];
                switch (defaultRoutingType) {
                  case "primary_standby": {
                    const viaIntf2 = settings.viaIntf2;
                    const viaIntf2Plugin = pl.getPluginInstance("interface", viaIntf2);
                    if (!viaIntf2Plugin)
                      this.fatal(`Cannot find global defautl interface plugin ${viaIntf2}`);
                    this.subscribeChangeFrom(viaIntf2Plugin);
                    wanStatus[viaIntf2] = {
                      active: false,
                      ready: true
                    };
                    // inherit active/ready based on seq
                    for (const intf of Object.keys(lastWanStatus)) {
                      if (lastWanStatus[intf].seq === 1) {
                        wanStatus[viaIntf2].active = lastWanStatus[intf].active;
                        wanStatus[viaIntf2].ready = lastWanStatus[intf].ready;
                        break;
                      }
                    }
                    if (await viaIntf2Plugin.isInterfacePresent() === false) {
                      // need to publish wan conn change events if it was ready previously
                      if (wanStatus[viaIntf2].ready === true) {
                        changeDescs.push({
                          intf: viaIntf2,
                          ready: false,
                          wanSwitched: wanStatus[viaIntf2].active === true ? true : false,
                          failures: [{type: "carrier"}]
                        });
                      }
                      // directly mark ready to false if interface does not exist at the moment
                      wanStatus[viaIntf2].ready = false;
                      wanStatus[viaIntf2].active = false;
                    }
                    wanStatus[viaIntf2].seq = 1;
                    wanStatus[viaIntf2].plugin = viaIntf2Plugin;
                  }
                  case "single": {
                    const viaIntf = settings.viaIntf;
                    const viaIntfPlugin = pl.getPluginInstance("interface", viaIntf);
                    if (!viaIntfPlugin)
                      this.fatal(`Cannot find global default interface plugin ${viaIntf}`);
                    this.subscribeChangeFrom(viaIntfPlugin);
                    wanStatus[viaIntf] = {
                      active: false,
                      ready: true
                    };
                    for (const intf of Object.keys(lastWanStatus)) {
                      if (lastWanStatus[intf].seq === 0) {
                        wanStatus[viaIntf].active = lastWanStatus[intf].active;
                        wanStatus[viaIntf].ready = lastWanStatus[intf].ready;
                        break;
                      }
                    }
                    if (await viaIntfPlugin.isInterfacePresent() === false) {
                      // need to publish wan conn change events if it was ready previously
                      if (wanStatus[viaIntf].ready === true) {
                        changeDescs.push({
                          intf: viaIntf,
                          ready: false,
                          wanSwitched: wanStatus[viaIntf].active === true && type !== "single" ? true : false,
                          failures: [{type: "carrier"}]
                        });
                      }
                      // directly mark ready to false if interface does not exist at the moment
                      wanStatus[viaIntf].ready = false;
                      wanStatus[viaIntf].active = false;
                    }
                    wanStatus[viaIntf].seq = 0;
                    wanStatus[viaIntf].plugin = viaIntfPlugin;
                    break;
                  }
                  case "load_balance": {
                    const nextHops = settings.nextHops;
                    let seq = 0;
                    for (let nextHop of nextHops) {
                      const viaIntf = nextHop.viaIntf;
                      const viaIntfPlugin = pl.getPluginInstance("interface", viaIntf);
                      if (viaIntfPlugin) {
                        this.subscribeChangeFrom(viaIntfPlugin);
                        wanStatus[viaIntf] = {
                          active: false,
                          ready: true
                        };
                        for (const intf of Object.keys(lastWanStatus)) {
                          if (lastWanStatus[intf].seq === seq) {
                            wanStatus[viaIntf].active = lastWanStatus[intf].active;
                            wanStatus[viaIntf].ready = lastWanStatus[intf].ready;
                            break;
                          }
                        }
                        if (await viaIntfPlugin.isInterfacePresent() === false) {
                          // need to publish wan conn change events if it was ready previously
                          if (wanStatus[viaIntf].ready === true) {
                            changeDescs.push({
                              intf: viaIntf,
                              ready: false,
                              wanSwitched: true,
                              failures: [{ type: "carrier" }]
                            });
                          }
                          // directly mark ready to false if interface does not exist at the moment
                          wanStatus[viaIntf].ready = false;
                          wanStatus[viaIntf].active = false;
                        }
                        wanStatus[viaIntf].seq = seq;
                        wanStatus[viaIntf].weight = nextHop.weight;
                        wanStatus[viaIntf].plugin = viaIntfPlugin;
                      } else {
                        this.fatal(`Cannot find global default interface plugin ${viaIntf}`);
                      }
                      seq++;
                    }
                    const hashPolicy = settings.hashPolicy || "l3";
                    switch (hashPolicy) {
                      case "l4": {
                        await exec(`sudo sysctl -w net.ipv4.fib_multipath_hash_policy=1`).catch((err) => { });
                        // ipv6 multipath configuration is not supported yet in our image, but it will be supported in later kernel version
                        await exec(`sudo sysctl -w net.ipv6.fib_multipath_hash_policy=1`).catch((err) => { });
                        break;
                      }
                      case "l3":
                      default: {
                        await exec(`sudo sysctl -w net.ipv4.fib_multipath_hash_policy=0`).catch((err) => { });
                        // ipv6 multipath configuration is not supported yet in our image, but it will be supported in later kernel version
                        await exec(`sudo sysctl -w net.ipv6.fib_multipath_hash_policy=0`).catch((err) => { });
                      }
                    }
                    break;
                  }
                }
                // in apply context here
                this._wanStatus = wanStatus;
                await this._applyActiveGlobalDefaultRouting(false);
                if (!_.isEmpty(changeDescs)) {
                  for (const desc of changeDescs) {
                    this.enrichWanStatus(this.getWANConnStates()).then((enrichedWanStatus) => {
                      if (enrichedWanStatus) {
                        desc.currentStatus = enrichedWanStatus;
                        this.publishWANConnChange(desc);
                      }
                    }).catch((err) => {
                      this.log.error("Failed to enrich WAN status", err.message);
                    });
                  }
                }
                break;
              }
              case "static": {
                const routes = settings.routes || [];
                for (const route of routes) {
                  const { dest, gw, dev, af } = route;
                  if (!dest && !dev) {
                    this.log.error(`dest and dev should be specified for global static route`);
                    continue;
                  }
                  const ifacePlugin = pl.getPluginInstance("interface", dev);
                  if (!ifacePlugin) {
                    this.log.error(`Static route dest interface plugin ${dev} not found`);
                  } else {
                    // use allow IPs in wireguard to implement static route on wireguard interface
                    if (ifacePlugin instanceof WireguardInterfacePlugin) {
                      this.log.error(`Cannot use wireguard interface ${dev} as dev in static route`);
                      continue;
                    } else {
                      this.subscribeChangeFrom(ifacePlugin);
                    }
                  }
                  let iface = dev;
                  if (iface.includes(":")) {
                    // virtual interface, need to strip suffix
                    iface = dev.substr(0, dev.indexOf(":"));
                  }
                  await routing.addRouteToTable(dest, gw, iface, routing.RT_STATIC, null, af).catch((err) => {
                    this.log.error(`Failed to add static global route`, route, err.message);
                  });
                }
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
                  wanStatus[viaIntf] = {
                    active: true, // always set active to true for non-global routing plugin
                    ready: true,
                    seq: 0,
                    plugin: viaIntfPlugin
                  };
                  // local and default routing table accesible to the interface
                  await routing.createPolicyRoutingRule("all", iface, `${viaIntf}_local`, 2001);
                  await routing.createPolicyRoutingRule("all", iface, `${viaIntf}_default`, 7001);
                  await routing.createPolicyRoutingRule("all", iface, `${viaIntf}_local`, 2001, null, 6);
                  await routing.createPolicyRoutingRule("all", iface, `${viaIntf}_default`, 7001, null, 6);
                } else {
                  this.fatal(`Cannot find global default interface plugin ${viaIntf}`)
                }
                this._wanStatus = wanStatus;
                break;
              }
              case "static": {
                const routes = settings.routes || [];
                for (const route of routes) {
                  const { dest, gw, dev, af } = route;
                  if (!dest && !dev) {
                    this.log.error(`dest and dev should be specified for static route of ${this.name}`);
                    continue;
                  }
                  const ifacePlugin = pl.getPluginInstance("interface", dev);
                  if (!ifacePlugin) {
                    this.log.error(`Static route dest interface plugin ${dev} not found`);
                  } else {
                    if (ifacePlugin instanceof WireguardInterfacePlugin) {
                      this.log.error(`Cannot use wireguard interface ${dev} as dev in static route`);
                      continue;
                    } else {
                      this.subscribeChangeFrom(ifacePlugin);
                    }
                  }
                  let iface = dev;
                  if (iface.includes(":")) {
                    // virtual interface, need to strip suffix
                    iface = dev.substr(0, dev.indexOf(":"));
                  }
                  await routing.addRouteToTable(dest, gw, iface, `${this.name}_static`, null, af).catch((err) => {
                    this.log.error(`Failed to add static route for ${this.name}`, route, err.message);
                  });
                }
                break;
              }
              default:
                this.log.error(`Unsupported routing type for ${this.name}: ${type}`);
            }
          }
        }
      }
    });
  }

  getActiveWANPlugins() {
    if (this._wanStatus)
      return Object.keys(this._wanStatus).filter(i => this._wanStatus[i].active).sort((a, b) => this._wanStatus[a].seq - this._wanStatus[b].seq).map(i => this._wanStatus[i].plugin);
    else
      return null;
  }

  getAllWANPlugins() {
    if (this._wanStatus)
      return Object.keys(this._wanStatus).sort((a, b) => this._wanStatus[a].seq - this._wanStatus[b].seq).map(i => this._wanStatus[i].plugin);
    else
      return null;
  }

  getPrimaryWANPlugin() {
    if (this._wanStatus) {
      const iface = Object.keys(this._wanStatus).sort((a, b) => this._wanStatus[a].seq - this._wanStatus[b].seq)[0];
      return this._wanStatus[iface].plugin;
    } else
      return null;
  }

  getWANConnStates() {
    if (this._wanStatus) {
      const result = {};
      Object.keys(this._wanStatus).sort((a, b) => this._wanStatus[a].seq - this._wanStatus[b].seq).forEach(i => {
        result[i] = {
          ready: this._wanStatus[i].ready,
          active: this._wanStatus[i].active,
          pendingTest: this._wanStatus[i].pendingTest
        };
      });
      return result;
    }
    return null;
  }

  getWANConnState(name) {
    if (this._wanStatus && this._wanStatus[name]) {
      return {
        ready: this._wanStatus[name].ready,
        active: this._wanStatus[name].active,
      };
    }
    return null;
  }

  onEvent(e) {
    if (!event.isLoggingSuppressed(e))
      this.log.info(`Received event on ${this.name}`, e);
    const eventType = event.getEventType(e);
    switch (eventType) {
      case event.EVENT_IP_CHANGE: {
        this._reapplyNeeded = true;
        pl.scheduleReapply();
        break;
      }
      case event.EVENT_IP6_CHANGE: {
        this.flush(6).then(() => this._applyActiveGlobalDefaultRouting(true, 6)).then(() => pl.publishChangeApplied()).catch((err) => {
          this.log.error(`Failed to apply active global default routes for IPv6 change event`, err.message);
        });
        break;
      }
      case event.EVENT_IF_UP: {
        if (this.name !== "global")
          return;
        const payload = event.getEventPayload(e);
        const intf = payload && payload.intf;
        for (const wan of Object.keys(this._wanStatus)) {
          const intfPlugin  = pl.getPluginInstance("interface", wan);
          // either intf is a wan interface or is an underlying interface of a wan interface
          if (intfPlugin && (
            wan === intf || 
            (_.isArray(intfPlugin.networkConfig.intf) && intfPlugin.networkConfig.intf.includes(intf)) || 
            (_.isString(intfPlugin.networkConfig.intf) && intfPlugin.networkConfig.intf === intf)
          ) && intfPlugin.isStaticIP()) {
            pl.acquireApplyLock(async () => {
              this._reapplyNeeded = true;
              this.propagateConfigChanged(true);
              pl.scheduleReapply();
            }).catch((err) => {});
          }
        }
        break;
      }
      case event.EVENT_WAN_CONN_CHECK: {
        // this event is also handled in interface plugin, which is the upstream plugin of routing plugin,
        // onEvent of upstream plugin is already completed and wan interface internal state is updated before this function is invoked
        const payload = event.getEventPayload(e);
        if (!payload)
          return;
        if (this.name !== "global")
          return;
        const type = (this.networkConfig && this.networkConfig.default && this.networkConfig.default.type) || "single";
        const intf = payload.intf;
        const failures = payload.failures;
        if (!this._wanStatus[intf]) {
          this.log.warn(`Interface ${intf} is not defined in global routing plugin, ignore event`, e);
          return;
        }
        const currentStatus = this._wanStatus[intf];
        const intfPlugin = pl.getPluginInstance("interface", intf);
        if (!intfPlugin) {
          this.log.error(`Cannot find interface plugin ${intf} from wan_conn_check event`);
          return;
        }
        currentStatus.pendingTest = false;
        let changeActiveWanNeeded = false;
        let changeDesc = null;
        if (currentStatus.ready && !intfPlugin.isReady()) {
          currentStatus.ready = false;
          if (currentStatus.active && type !== "single")
            changeActiveWanNeeded = true;

          changeDesc = {
            intf: intf,
            ready: false,
            wanSwitched: changeActiveWanNeeded,
            failures: failures
          };
        }
        if (!currentStatus.ready && intfPlugin.isReady()) {
          currentStatus.ready = true;
          // need to be stricter if inactive WAN is back to ready or fast failback if no WAN is active currently
          switch (type) {
            case "load_balance": {
              changeActiveWanNeeded = true;
              break;
            }
            case "primary_standby": {
              const failback = (this.networkConfig["default"] && this.networkConfig["default"].failback) || false;
              if (this.getActiveWANPlugins().length === 0 || (failback && currentStatus.seq === 0))
                // apply WAN settings in failback mode if primary WAN is back to ready
                changeActiveWanNeeded = true;
              break;
            }
            default:
          }
          changeDesc = {
            intf: intf,
            ready: true,
            wanSwitched: changeActiveWanNeeded,
            failures: failures
          };
        }
        if (changeDesc) {
          this.processWANConnChange(); // no need to await
          if (changeActiveWanNeeded) {
            this.scheduleApplyActiveGlobalDefaultRouting(changeDesc);
          } else {
            this.enrichWanStatus(this.getWANConnStates()).then((enrichedWanStatus) => {
              if (enrichedWanStatus) {
                changeDesc.currentStatus = enrichedWanStatus;
                this.publishWANConnChange(changeDesc);
              }
            }).catch((err) => {
              this.log.error("Failed to enrich WAN status", err.message);
            });
          }
        }
      }
      default:
    }
  }

  // in seconds
  getApplyTimeoutInterval(changeDesc = {}) {
    const failures = changeDesc.failures || [];
    const carrierFailures = failures.filter((x) => x.type === 'carrier');
    const hasCarrierError = !_.isEmpty(carrierFailures);

    if(!this.lastApplyTimestamp) {
      return hasCarrierError ? 0.5 : 3;
    }

    const secondsSinceLastApply = Math.floor(new Date() / 1000 - this.lastApplyTimestamp / 1000);
    if(secondsSinceLastApply > 20) {
      return hasCarrierError ? 0.5 : 3;
    }

    return hasCarrierError ? 3 : 10;
  }

  scheduleApplyActiveGlobalDefaultRouting(changeDesc) {
    this._pendingChangeDescs = this._pendingChangeDescs || [];
    this._pendingChangeDescs.push(changeDesc);

    const timeoutInterval = this.getApplyTimeoutInterval(changeDesc);

    if (this.applyActiveGlobalDefaultRoutingTask) {
      this.log.info("Cancelled scheduled active global default routing change");
      clearTimeout(this.applyActiveGlobalDefaultRoutingTask);
    }

    this.log.info(`Going to change global default routing in ${timeoutInterval} seconds...`);
    this.applyActiveGlobalDefaultRoutingTask = setTimeout(() => {
      this.log.info("Apply active global default routing", Object.keys(this._wanStatus).map(i => {
        return {
          name: i,
          ready: this._wanStatus[i].ready,
          seq: this._wanStatus[i].seq
        };
      }));
      // in async context here
      this._applyActiveGlobalDefaultRouting(true).then(() => {
        const e = event.buildEvent(event.EVENT_WAN_SWITCHED, {});
        this.propagateEvent(e);
        if (!_.isEmpty(this._pendingChangeDescs)) {
          for (const desc of this._pendingChangeDescs) {
            this.enrichWanStatus(this.getWANConnStates()).then((enrichedWanStatus) => {
              if (enrichedWanStatus) {
                desc.currentStatus = enrichedWanStatus;
                this.publishWANConnChange(desc);
              }
            });
          }
        }
        this._pendingChangeDescs = [];
      }).catch((err) => {
        this.log.error("Failed to apply active global default routing", err.message);
      });
    }, timeoutInterval * 1000);
  }

  async enrichWanStatus(wanStatus) {
    if (wanStatus) {
      const result = {};
      for (const i of Object.keys(wanStatus).sort((a, b) => wanStatus[a].seq - wanStatus[b].seq)) {
        const ifacePlugin = pl.getPluginInstance("interface",i);
        if (ifacePlugin && ifacePlugin.networkConfig && ifacePlugin.networkConfig.meta &&
            ifacePlugin.networkConfig.meta.name && ifacePlugin.networkConfig.meta.uuid &&
            ('ready' in wanStatus[i]) && ('active' in wanStatus[i]) ) {
          result[i] = {
            wan_intf_name: ifacePlugin.networkConfig.meta.name,
            wan_intf_uuid: ifacePlugin.networkConfig.meta.uuid,
            ready: wanStatus[i].ready,
            active: wanStatus[i].active
          };
          const ip4s = await ifacePlugin.getIPv4Addresses();
          if (ip4s) {
            result[i].ip4s = ip4s
          }
        }
      };
      return result;
    }
    return null;
  }

  async publishWANConnChange(changeDesc) {
    this.log.info("publish WAN :",changeDesc);

    // publish to redis db used by Firewalla
    await pclient.publishAsync(Message.MSG_FR_WAN_CONN_CHANGED, JSON.stringify(changeDesc)).catch((err) => {});
  }

  async processWANConnChange() {
    const state = this.isAnyWanConnected();
    const anyUp = state && state.connected;
    const lastAnyUp = this.lastAnyUp;
    if (anyUp === lastAnyUp) {
      return;
    }

    this.lastAnyUp = anyUp;

    if(anyUp) {
      await this.notifyAnyWanUp(state);
    } else {
      await this.notifyAllWanDown(state);
    }
  }

  async notifyAnyWanUp(state) {
    this.log.info("at least one wan is back online, publishing redis message and set led...");
    await platform.ledAnyNetworkUp();
    await pclient.publishAsync(Message.MSG_FR_WAN_CONN_ANY_UP, JSON.stringify(state)).catch((err) => {});
  }

  async notifyAllWanDown(state) {
    this.log.info("all wan are down, publishing redis message and set led...");
    await platform.ledAllNetworkDown();
    await pclient.publishAsync(Message.MSG_FR_WAN_CONN_ALL_DOWN, JSON.stringify(state)).catch((err) => {});
    await pclient.publishAsync(Message.MSG_FIRERESET_BLUETOOTH_CONTROL, "1").catch((err) => {});
  }

  isAnyWanConnected() {
    const states = this.getWANConnStates();
    let connected = false;
    const subStates = {};
    for(const intf in states) {
      const state = states[intf];
      if(state.ready) {
        connected = true;
      }
      subStates[intf] = {active: state.ready};
    }
    return {
      connected,
      wans: subStates
    };
  }
}


module.exports = RoutingPlugin;
