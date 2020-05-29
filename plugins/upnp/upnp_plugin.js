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

  async flush() {
    await exec(`sudo systemctl stop firerouter_upnpd@${this.name}`).catch((err) => {});
    await fs.unlinkAsync(this._getConfigFilePath()).catch((err) => {});
    await exec(`sudo iptables -w -t nat -F ${this._getNATChain()}`).catch((err) => {});
    if (this._currentExtIp4)
      await exec(util.wrapIptables(`sudo iptables -w -t nat -D FR_UPNP -d ${this._currentExtIp4} -j ${this._getNATChain()}`)).catch((err) => {});
    await exec(util.wrapIptables(`sudo ip6tables -w -t nat -D FR_UPNP -j ${this._getNATChain()}`)).catch((err) => {});
  }

  async generateConfig(uuid, extIntf, internalIP, internalNetwork) {
    const natpmpEnabled = (this.networkConfig.enableNatpmp !== true) ? false : true; // default to false
    const upnpEnabled = (this.networkConfig.enableUpnp !== false); // default to true
    let content = await fs.readFileAsync(`${__dirname}/miniupnpd.conf.template`, {encoding: 'utf8'});
    content = content.replace(/%EXTERNAL_INTERFACE%/g, extIntf);
    content = content.replace(/%LISTENING_IP%/g, internalIP);
    content = content.replace(/%INTERNAL_INTERFACE%/g, this.name);
    content = content.replace(/%ENABLE_NATPMP%/g, natpmpEnabled ? "yes" : "no");
    content = content.replace(/%ENABLE_UPNP%/g, upnpEnabled ? "yes" : "no");
    content = content.replace(/%UUID%/g, uuid);
    content = content.replace(/%INTERNAL_NETWORK%/g, internalNetwork);
    await fs.writeFileAsync(this._getConfigFilePath(), content, {encoding: 'utf8'});
  }

  async apply() {
    const extIntf = this.networkConfig.extIntf;
    if (!extIntf)
      this.fatal(`extIntf is not defined defined in upnp config of ${this.name}`);
    const extPlugin = pl.getPluginInstance("interface", extIntf);
    const intfPlugin = pl.getPluginInstance("interface", this.name);
    if (!extPlugin)
      this.fatal(`External interface plugin ${extIntf} is not found on upnp ${this.name}`);
    if (!intfPlugin)
      this.fatal(`Internal interface plugin ${this.name} is not found on upnp ${this.name}`);
    this.subscribeChangeFrom(extPlugin);
    this.subscribeChangeFrom(intfPlugin);

    const intState = await intfPlugin.state();
    if (!intState.ip4) {
      this.log.error(`Internal interface ${this.name} IPv4 address is not found`);
      return;
    }
    const extState = await extPlugin.state();
    if (!extState.ip4) {
      this.log.error(`External interface ${extIntf} IPv4 address is not found`);
      return;
    }
    const externalIP = extState.ip4.split('/')[0];

    // initialize iptables chains
    await exec(`sudo iptables -w -t nat -N ${this._getNATChain()} &> /dev/null`).catch((err) => {});
    await exec(`sudo ip6tables -w -t nat -N ${this._getNATChain()} &> /dev/null`).catch((err) => {});
    await exec(util.wrapIptables(`sudo iptables -w -t nat -A FR_UPNP -d ${externalIP} -j ${this._getNATChain()}`)).catch((err) => {
      this.log.error(`Failed to add UPnP chain for ${this.name}, external IP ${externalIP}`);
    });
    this._currentExtIp4 = externalIP;
    // do not add IPv6 support for UPnP
    // await exec(util.wrapIptables(`sudo ip6tables -w -t nat -A FR_UPNP -j ${this._getNATChain()}`)).catch((err) => {});

    const uuid = intfPlugin.networkConfig && intfPlugin.networkConfig.meta && intfPlugin.networkConfig.meta.uuid;
    const internalCidr = ip.cidrSubnet(intState.ip4);
    const internalIP = intState.ip4.split('/')[0];
    const internalNetwork = `${internalCidr.networkAddress}/${internalCidr.subnetMaskLength}`;
    await this.generateConfig(uuid, extIntf, internalIP, internalNetwork);
    await exec(`sudo systemctl restart firerouter_upnpd@${this.name}`);
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

module.exports = UPnPPlugin;