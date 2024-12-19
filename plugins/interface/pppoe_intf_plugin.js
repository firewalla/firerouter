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

const InterfaceBasePlugin = require('./intf_base_plugin.js');

const exec = require('child-process-promise').exec;
const r = require('../../util/firerouter.js');
const fs = require('fs');
const Promise = require('bluebird');
const pl = require('../plugin_loader.js');
Promise.promisifyAll(fs);
const event = require('../../core/event.js');

const pppoeTemplateFilePath = `${r.getFireRouterHome()}/etc/ppp.conf.template`

class PPPoEInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    // copy pppd hook script
    await exec(`sudo rm /etc/ppp/ip-up.d/firerouter_*`).catch((err) => {});
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_ppp_ip_up /etc/ppp/ip-up.d/`).catch((err) => {});
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_ppp_ipv6_up /etc/ppp/ipv6-up.d/`).catch((err) => {});
    await exec(`mkdir -p ${r.getUserConfigFolder()}/pppoe`).catch((err) => {});
    // copy firerouter_pppd.service
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_pppd@.service /etc/systemd/system/`);
  }

  async flushIP(af = null) {
    if (!af) {
      await exec(`sudo systemctl stop firerouter_pppd@${this.name}`).catch((err) => {});
      await exec(`rm -f ${this._getConfFilePath()}`).catch((err) => {});
      // make sure to stop dhcpv6 client no matter if dhcp6 is enabled
      await exec(`sudo systemctl stop firerouter_dhcpcd6@${this.name}`).catch((err) => {});
      // remove dhcpcd lease file to ensure it will trigger PD_CHANGE event when it is re-applied
      const lease6Filename = await this._getDHCPCDLease6Filename();
      if (lease6Filename)
        await exec(`sudo rm -f ${lease6Filename}`).catch((err) => {});
    } else
      await super.flushIP(af);
  }

  isWAN() {
    return true;
  }

  isLAN() {
    return false;
  }

  _getConfFilePath() {
    return `${r.getUserConfigFolder()}/pppoe/${this.name}.conf`;
  }

  _getResolvConfFilePath() {
    return `/etc/ppp/${this.name}.resolv.conf`
  }

  async createInterface() {
    // create config file instead
    if (!this.networkConfig || !this.networkConfig.username || !this.networkConfig.password) {
      this.log.error("username or password is not specified for pppoe", this.name);
      return false;
    }
    let config = await fs.readFileAsync(pppoeTemplateFilePath, {encoding: "utf8"});
    const username = this.networkConfig.username;
    const password = this.networkConfig.password;
    const intf = this.networkConfig.intf;
    const mru = this.networkConfig.mru || 1492;
    const mtu = this.networkConfig.mtu || 1492;
    const linkname = this.name;
    config = config.replace("#USERNAME#", username)
      .replace("#PASSWORD#", password)
      .replace("#INTF#", intf)
      .replace("#MRU#", mru)
      .replace("#MTU#", mtu)
      .replace(/#LINKNAME#/g, linkname);
    if (this.networkConfig.dhcp6 || (this.networkConfig.ipv6 && this.networkConfig.ipv6.length > 0))
      config = `${config}\n+ipv6`;
    if (this.networkConfig.serviceName)
      config = `${config}\nrp_pppoe_service '${this.networkConfig.serviceName}'`;
    const intfPlugin = pl.getPluginInstance("interface", intf);
    if (intfPlugin) {
      this.subscribeChangeFrom(intfPlugin);
      await fs.writeFileAsync(this._getConfFilePath(), config);
    } else {
      this.fatal(`Failed to find interface plugin ${intf}`);
    }
    return true;
  }

  async interfaceUpDown() {
    if (this.networkConfig.enabled) {
      await exec(`sudo systemctl restart firerouter_pppd@${this.name}`).catch((err) => {
        this.log.error(`Failed to enable pppd on interface ${this.name}: ${err.message}`);
      });
    } else {
      await exec(`sudo systemctl stop firerouter_pppd@${this.name}`).catch((err) => {});
    }
  }

  async applyIpSettings() {
    // IPv4 address is assigned by pppd and IPv6 will be triggered by event if applicable
  }

  async applyDnsSettings() {
    await fs.accessAsync(r.getInterfaceResolvConfPath(this.name), fs.constants.F_OK).then(() => {
      this.log.info(`Remove old resolv conf for ${this.name}`);
      return fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name));
    }).catch((err) => { });
    // specified DNS nameservers supersedes those assigned by DHCP
    if (this.networkConfig.nameservers && this.networkConfig.nameservers.length > 0) {
      const nameservers = this.networkConfig.nameservers.map((nameserver) => `nameserver ${nameserver}`).join("\n");
      await fs.writeFileAsync(r.getInterfaceResolvConfPath(this.name), nameservers);
    } else {
      await fs.symlinkAsync(this._getResolvConfFilePath(), r.getInterfaceResolvConfPath(this.name));
    }
  }

  async carrierState() {
    // carrier of pppoe interface in /sys/class/net is not up-to-date, need to get carrier of base interface
    const state = await super.carrierState();
    let baseIntfState = state;
    if (state === "1") {
      if (this.networkConfig.intf) {
        const baseIntfPlugin = pl.getPluginInstance("interface", this.networkConfig.intf);
        if (baseIntfPlugin)
          baseIntfState = await baseIntfPlugin.carrierState();
      }
    }
    return baseIntfState;
  }

  hasHardwareAddress() {
    return false;
  }

  onEvent(e) {
    super.onEvent(e);
    const eventType = event.getEventType(e);
    if (eventType === event.EVENT_PPPOE_IPV6_UP) {
      this.applyIpv6Settings().catch((err) => {
        this.log.error(`Failed to apply IPv6 settings on ${this.name}`, err.message);
      });
    }
    if (eventType === event.EVENT_IP_CHANGE) {
      this.setSysOpts().catch((err) => {
        this.log.error(`Failed to set sys opts on ${this.name}`, err.message);
      });
    }
  }
}

module.exports = PPPoEInterfacePlugin;