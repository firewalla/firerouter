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

'use strict'

let instance = null;
const pl = require('../plugins/plugin_loader.js');
const routing = require('../util/routing.js');
const r = require('../util/firerouter.js');
const util = require('../util/util.js');

const exec = require('child-process-promise').exec;

class NetworkSetup {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async prepareEnvironment() {
    // create dhclient runtime folder
    await exec(`mkdir -p ${r.getRuntimeFolder()}/dhclient`);
    // copy dhclient-script
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/dhclient-script /sbin/dhclient-script`);
    // cleanup legacy config files
    await exec(`rm -f ${r.getFireRouterHome()}/etc/dnsmasq.dns.*.conf`).catch((err) => {});
    await exec(`rm -f ${r.getUserConfigFolder()}/sshd/*`).catch((err) => {});
    // flush iptables
    await exec(`sudo iptables -w -t nat -N FR_PREROUTING || true`);
    await exec(`sudo iptables -w -t nat -N FR_POSTROUTING || true`);
    await exec(`sudo iptables -w -t nat -F FR_PREROUTING || true`);
    await exec(`sudo iptables -w -t nat -F FR_POSTROUTING || true`);
    await exec(util.wrapIptables(`sudo iptables -w -t nat -I PREROUTING -j FR_PREROUTING`));
    await exec(util.wrapIptables(`sudo iptables -w -t nat -I POSTROUTING -j FR_POSTROUTING`));
    // reset ip rules
    await routing.flushPolicyRoutingRules();
    await routing.createPolicyRoutingRule("all", null, "local", 0); 
    await routing.createPolicyRoutingRule("all", null, "main", 32766);
    await routing.createPolicyRoutingRule("all", null, "default", 32767);
    // create routing tables
    await routing.createCustomizedRoutingTable(routing.RT_GLOBAL_LOCAL);
    await routing.createCustomizedRoutingTable(routing.RT_GLOBAL_DEFAULT);
    await routing.createCustomizedRoutingTable(routing.RT_WAN_ROUTABLE);
    await routing.createCustomizedRoutingTable(routing.RT_LAN_ROUTABLE);
    await routing.createCustomizedRoutingTable(routing.RT_STATIC);
    await routing.flushRoutingTable(routing.RT_GLOBAL_LOCAL);
    await routing.flushRoutingTable(routing.RT_GLOBAL_DEFAULT);
    await routing.flushRoutingTable(routing.RT_WAN_ROUTABLE);
    await routing.flushRoutingTable(routing.RT_LAN_ROUTABLE);
    await routing.flushRoutingTable(routing.RT_STATIC);

    await routing.createPolicyRoutingRule("all", null, routing.RT_GLOBAL_LOCAL, 3000);
    await routing.createPolicyRoutingRule("all", null, routing.RT_STATIC, 4001);
  }

  async setup(config, dryRun = false) {
    const errors = await pl.reapply(config, dryRun);
    return errors;
  }

  async getWANs() {
    const allInterfacePlugins = pl.getPluginInstances("interface") || {};
    const wans = {};
    for (let name in allInterfacePlugins) {
      const plugin = allInterfacePlugins[name];
      if (plugin && plugin.isWAN()) {
        const state = await plugin.state();
        wans[name] = {config: plugin.networkConfig, state: state};
      }
    }
    return wans;
  }

  async getLANs() {
    const allInterfacePlugins = pl.getPluginInstances("interface") || {};
    const lans = {};
    for (let name in allInterfacePlugins) {
      const plugin = allInterfacePlugins[name];
      if (plugin && plugin.isLAN()) {
        const state = await plugin.state();
        lans[name] = {config: plugin.networkConfig, state: state};
      }
    }
    return lans;
  }

  async getInterfaces() {
    const allInterfacePlugins = pl.getPluginInstances("interface") || {};
    const interfaces = {};
    for (let name in allInterfacePlugins) {
      const plugin = allInterfacePlugins[name];
      if (plugin) {
        const state = await plugin.state();
        interfaces[name] = {config: plugin.networkConfig, state: state};
      }
    }
    return interfaces;
  }

  async getInterface(intf) {
    const plugin = pl.getPluginInstance("interface", intf);
    if (!plugin)
      return null;
    const state = await plugin.state();
    return {config: plugin.networkConfig, state: state};
  }
}

module.exports = new NetworkSetup();