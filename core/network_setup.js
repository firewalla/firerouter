
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
const fsp = require('fs').promises;

const exec = require('child-process-promise').exec;

class NetworkSetup {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async _getDHCPCDDuidFilename() {
    const version = await exec(`dhcpcd --version | head -n 1 | awk '{print $2}'`).then(result => result.stdout.trim()).catch((err) => {
      return null;
    });
    if (version) {
      if (version.startsWith("6."))
        return `/etc/dhcpcd.duid`;
      if (version.startsWith("7."))
        return `/var/lib/dhcpcd/duid`;
    }
    return null;
  }

  async prepareEnvironment() {
    // create dhclient runtime folder
    await exec(`mkdir -p ${r.getRuntimeFolder()}/dhclient`);
    // create dhclient config folder
    await exec(`mkdir -p ${r.getUserConfigFolder()}/dhclient`);
    // create dhcpv6 client config folder
    await exec(`mkdir -p ${r.getUserConfigFolder()}/dhcpcd6`);
    // create saved file folder
    await exec(`mkdir -p ${r.getRuntimeFolder()}/files`);
    // copy dhclient-script
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/dhclient-script /sbin/dhclient-script`);
    // copy rfc3442-classless-routes script
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/rfc3442-classless-routes /etc/dhcp/dhclient-exit-hooks.d/`);
    // redirect dhcpcd log to specific log file
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/12-dhcpcd.conf /etc/rsyslog.d/`);
    // redirect dhclient log to specific log file
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/12-dhclient.conf /etc/rsyslog.d/`)
    pl.scheduleRestartRsyslog();
    // copy logrotate config for dhcpcd log file
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/logrotate.d/dhcpcd /etc/logrotate.d/`);
    // copy logrotate config for dhclient log file
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/logrotate.d/dhclient /etc/logrotate.d/`);
    // cleanup legacy config files
    await exec(`rm -f ${r.getFireRouterHome()}/etc/dnsmasq.dns.*.conf`).catch((err) => {});
    await exec(`rm -f ${r.getUserConfigFolder()}/sshd/*`).catch((err) => {});
    // save persistent dhcpcd duid file into home directory
    const duidFilePath = await this._getDHCPCDDuidFilename();
    if (duidFilePath) {
      await exec(`sudo rm ${duidFilePath}`).catch((err) => {});
      await exec(`sudo touch ${r.getRuntimeFolder()}/dhcpcd.duid`).catch((err) => {});
      await exec(`sudo ln -sf ${r.getRuntimeFolder()}/dhcpcd.duid ${duidFilePath}`).catch((err) => {});
      let duid = await fsp.readFile(`${r.getRuntimeFolder()}/dhcpcd.duid`, {encoding: 'utf8'}).catch((err) => null);
      if (!duid) {
        // generate DUID based on link layer address of eth0, DUID-LL seems compatibile with most DHCPv6 servers
        const eth0Mac = await fsp.readFile("/sys/class/net/eth0/address", {encoding: "utf8"}).then((content) => content.trim()).catch((err) => null);
        if (eth0Mac) {
          duid = `00:03:${eth0Mac}`;
          await exec(`echo ${duid} | sudo tee ${r.getRuntimeFolder()}/dhcpcd.duid`).catch((err) => {});
        }
      }
    }
    // create routing tables
    await routing.createCustomizedRoutingTable(routing.RT_GLOBAL_LOCAL);
    await routing.createCustomizedRoutingTable(routing.RT_GLOBAL_DEFAULT);
    await routing.createCustomizedRoutingTable(routing.RT_WAN_ROUTABLE);
    await routing.createCustomizedRoutingTable(routing.RT_LAN_ROUTABLE);
    await routing.createCustomizedRoutingTable(routing.RT_STATIC);
    // prepare network environment
    await exec(`${r.getFireRouterHome()}/scripts/prepare_network_env.sh`);
  }

  async setup(config, dryRun = false) {
    const errors = await pl.reapply(config, dryRun);
    return errors;
  }

  async getWANs() {
    const allInterfacePlugins = pl.getPluginInstances("interface") || {};
    const wans = {};
    await Promise.all(Object.keys(allInterfacePlugins).map(async name => {
      const plugin = allInterfacePlugins[name];
      if (plugin && plugin.isWAN()) {
        const state = await plugin.state();
        wans[name] = {config: plugin.networkConfig, state: state};
      }
    }));
    return wans;
  }

  async getLANs() {
    const allInterfacePlugins = pl.getPluginInstances("interface") || {};
    const lans = {};
    await Promise.all(Object.keys(allInterfacePlugins).map(async name => {
      const plugin = allInterfacePlugins[name];
      if (plugin && plugin.isLAN()) {
        const state = await plugin.state();
        lans[name] = {config: plugin.networkConfig, state: state};
      }
    }));
    return lans;
  }

  async getInterfaces() {
    const allInterfacePlugins = pl.getPluginInstances("interface") || {};
    const interfaces = {};
    await Promise.all(Object.keys(allInterfacePlugins).map(async name => {
      const plugin = allInterfacePlugins[name];
      if (plugin) {
        const state = await plugin.state();
        interfaces[name] = {config: plugin.networkConfig, state: state};
      }
    }));
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