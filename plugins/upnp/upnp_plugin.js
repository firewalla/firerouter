/*    Copyright 2020 Firewalla Inc
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
const event = require('../../core/event.js');
const util = require('../../util/util.js');
const fs = require('fs');
const ip = require('ip');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const PlatformLoader = require('../../platform/PlatformLoader.js');
const platform = PlatformLoader.getPlatform();

class UPnPPlugin extends Plugin {
  static async preparePlugin() {
    await exec(`mkdir -p ${r.getUserConfigFolder()}/upnp`);
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_upnpd@.service /etc/systemd/system/`);
    // redirect miniupnpd log to specific log file
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/10-miniupnpd.conf /etc/rsyslog.d/`);
    await exec(`sudo systemctl daemon-reload`);
    pl.scheduleRestartRsyslog();
    // copy logrotate config for miniupnpd log file
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/logrotate.d/miniupnpd /etc/logrotate.d/`);
  }

  _getConfigFilePath() {
    return `${r.getUserConfigFolder()}/upnp/${this.name}.conf`;
  }

  _getNATChain() {
    return `UPNP_${this.name}`;
  }

  _getNATPostroutingChain() {
    return `UPNP_PR_${this.name}`;
  }

  _getFilterChain() {
    return `UPNP_${this.name}`;
  }

  async flush() {
    await exec(`sudo systemctl stop firerouter_upnpd@${this.name}`).catch((err) => {});
    await fs.unlinkAsync(this._getConfigFilePath()).catch((err) => {});
    await exec(`sudo iptables -w -t nat -F ${this._getNATChain()}`).catch((err) => {});
    await exec(`sudo iptables -w -F ${this._getFilterChain()}`).catch((err) => {});
    await exec(`sudo iptables -w -D FR_UPNP_ACCEPT -j ${this._getFilterChain()}`).catch((err) => {});
    await exec(`sudo iptables -w -t nat -F ${this._getNATPostroutingChain()}`).catch((err) => {});
    await exec(`sudo iptables -w -t nat -D FR_UPNP_POSTROUTING -j ${this._getNATPostroutingChain()}`).catch((err) => {});
    if (this._currentExtIp4)
      await exec(util.wrapIptables(`sudo iptables -w -t nat -D FR_UPNP -d ${this._currentExtIp4} -j ${this._getNATChain()}`)).catch((err) => {});
  }

  async generateConfig(uuid, extIntf, internalIPs, internalNetworks) {
    const natpmpEnabled = (this.networkConfig.enableNatpmp !== true) ? false : true; // default to false
    const upnpEnabled = (this.networkConfig.enableUpnp !== false); // default to true
    let content = await fs.readFileAsync(`${__dirname}/miniupnpd.conf.template`, {encoding: 'utf8'});
    content = content.replace(/%EXTERNAL_INTERFACE%/g, extIntf);
    const listeningIPs = internalIPs.map(ip => `listening_ip=${ip}`);
    content = content.replace(/%LISTENING_IP%/g, listeningIPs.join("\n"));
    content = content.replace(/%INTERNAL_INTERFACE%/g, this.name);
    content = content.replace(/%ENABLE_NATPMP%/g, natpmpEnabled ? "yes" : "no");
    content = content.replace(/%ENABLE_UPNP%/g, upnpEnabled ? "yes" : "no");
    content = content.replace(/%UUID%/g, uuid);
    content = content.replace(/%MODEL_NAME%/g, platform.getModelName() || "Firewalla");
    const allowNetworks = internalNetworks.map(n => `allow 1024-65535 ${n} 1024-65535`);
    content = content.replace(/%ALLOW_NETWORK%/g, allowNetworks.join("\n"));
    await fs.writeFileAsync(this._getConfigFilePath(), content, {encoding: 'utf8'});
  }

  async apply() {
    let extIntf = this.networkConfig.extIntf;
    let extPlugin = null;
    if (!extIntf) {
      this.log.info(`extIntf is not explicitly defined, will use active WAN from routing_plugins instead`);
      const routingPlugin = pl.getPluginInstance("routing", "global");
      if (!routingPlugin) {
        this.fatal("Global default routing plugin is not defined");
      } else {
        this.subscribeChangeFrom(routingPlugin);
        const activeWANPlugins = routingPlugin.getActiveWANPlugins();
        if (activeWANPlugins.length > 0) {
          extPlugin = activeWANPlugins[0];
          extIntf = extPlugin.name;
        }
      }
    } else {
      extPlugin = pl.getPluginInstance("interface", extIntf);
      if (!extPlugin)
        this.fatal(`External interface plugin ${extIntf} is not found on upnp ${this.name}`);
      this.subscribeChangeFrom(extPlugin);
    }
    if (!extPlugin || !extIntf) {
      this.log.error(`No active WAN is found, mdns reflector will not be applied on ${this.name}`);
      return;
    }
    const intfPlugin = pl.getPluginInstance("interface", this.name);
    if (!intfPlugin) {
      this.log.error(`Internal interface plugin ${this.name} is not found on upnp ${this.name}`);
      return;
    }
    this.subscribeChangeFrom(intfPlugin);

    const intState = await intfPlugin.state();
    if (!intState.ip4s || intState.ip4s.length === 0) {
      this.log.error(`Internal interface ${this.name} IPv4 address is not found`);
      return;
    }
    const extState = await extPlugin.state();
    if (!extState.ip4s || extState.ip4s.length === 0) {
      this.log.error(`External interface ${extIntf} IPv4 address is not found`);
      return;
    }
    const externalIP = extState.ip4.split('/')[0];

    // initialize iptables chains
    await exec(`sudo iptables -w -t nat -N ${this._getNATChain()} &> /dev/null`).catch((err) => {});
    await exec(util.wrapIptables(`sudo iptables -w -t nat -A FR_UPNP -d ${externalIP} -j ${this._getNATChain()}`)).catch((err) => {
      this.log.error(`Failed to add UPnP chain for ${this.name}, external IP ${externalIP}`);
    });
    await exec(`sudo iptables -w -t nat -N ${this._getNATPostroutingChain()} &> /dev/null`).catch((err) => {});
    await exec(util.wrapIptables(`sudo iptables -w -t nat -A FR_UPNP_POSTROUTING -j ${this._getNATPostroutingChain()}`)).catch((err) => {});
    await exec(`sudo iptables -w -N ${this._getFilterChain()} &> /dev/null`).catch((err) => {});
    await exec(util.wrapIptables(`sudo iptables -w -A FR_UPNP_ACCEPT -j ${this._getFilterChain()}`)).catch((err) => {});

    this._currentExtIp4 = externalIP;
    // do not add IPv6 support for UPnP
    // await exec(util.wrapIptables(`sudo ip6tables -w -t nat -A FR_UPNP -j ${this._getNATChain()}`)).catch((err) => {});

    const uuid = intfPlugin.networkConfig && intfPlugin.networkConfig.meta && intfPlugin.networkConfig.meta.uuid;
    const internalCidrs = intState.ip4s.map(ip4 => ip.cidrSubnet(ip4));
    const internalIPs = intState.ip4s.sort().filter((v, i, a) => a.indexOf(v) === i);
    const internalNetworks = internalCidrs.map(internalCidr => `${internalCidr.networkAddress}/${internalCidr.subnetMaskLength}`).sort().filter((v, i, a) => a.indexOf(v) === i);
    await this.generateConfig(uuid, extIntf, internalIPs, internalNetworks);
    await exec(`sudo systemctl restart firerouter_upnpd@${this.name}`);
  }

  onEvent(e) {
    if (!event.isLoggingSuppressed(e))
      this.log.info(`Received event on ${this.name}`, e);
    const eventType = event.getEventType(e);
    switch (eventType) {
      case event.EVENT_WAN_SWITCHED:
      case event.EVENT_IP_CHANGE: {
        this._reapplyNeeded = true;
        pl.scheduleReapply();
        break;
      }
      default:
    }
  }
}

module.exports = UPnPPlugin;
