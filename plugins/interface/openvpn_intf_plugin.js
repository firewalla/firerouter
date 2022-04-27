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

const InterfaceBasePlugin = require('./intf_base_plugin.js');

const exec = require('child-process-promise').exec;
const fs = require('fs');
const Promise = require('bluebird');
const pl = require('../plugin_loader.js');
const event = require('../../core/event.js');
const routing = require('../../util/routing.js');
const ip = require('ip');
const _ = require('lodash');
Promise.promisifyAll(fs);

class OpenVPNInterfacePlugin extends InterfaceBasePlugin {
  // this is a semi-stub now, it is not used to bring up to shutdown interface
  // however, it still can be used to get state of OpenVPN tunnel interface and populate routing table
  // it can also be referred in other plugins, e.g., dns

  static async preparePlugin() {

  }

  async flushIP() {

  }

  async createInterface() {
    // stub implmentation
    const up = await exec(`ip link show dev ${this.name}`).then(() => true).catch(() => false);
    // a tricky to change enabled status of networkConfig in memory, other plugins that are dependent on this plugin can read this change
    this.networkConfig.enabled = up;
    return true;
  }

  async interfaceUpDown() {
    
  }

  async changeRoutingTables() {
    // stub implementation
    await super.changeRoutingTables();
    if (this.networkConfig.type === "server") {
      const up = await exec(`ip link show dev ${this.name}`).then(() => true).catch(() => false);
      if (up) {
        const subnet = await fs.readFileAsync(`/etc/openvpn/ovpn_server/${this.networkConfig.instance || "server"}.subnet`, {encoding: "utf8"})
          .then(content => content.trim())
          .catch((err) => {
            this.log.error(`Failed to read .subnet file for openvpn ${this.name} ${this.networkConfig.instance}`, err.message);
            return null;
          });
        const peer = await fs.readFileAsync(`/etc/openvpn/ovpn_server/${this.networkConfig.instance || "server"}.gateway`, {encoding: "utf8"})
          .then(content => content.trim())
          .catch((err) => {
            this.log.error(`Failed to read .gateway file for openvpn ${this.name} ${this.networkConfig.instance}`, err.message);
            return null;
          });
        if (subnet && peer) {
          await routing.addRouteToTable(`${subnet}`, peer, this.name, routing.RT_WAN_ROUTABLE).catch((err) => {});
          if (this.networkConfig.isolated !== true) {
            // routable to/from other routable lans
            await routing.addRouteToTable(`${subnet}`, peer, this.name, routing.RT_LAN_ROUTABLE).catch((err) => {});
          }
          await routing.addRouteToTable(`${subnet}`, peer, this.name, `${this.name}_local`).catch((err) => {});
          await routing.addRouteToTable(`${subnet}`, peer, this.name, `${this.name}_default`).catch((err) => {});
        }
      }
    }
  }

  onEvent(e) {
    // stub implementation
    if (!event.isLoggingSuppressed(e))
      this.log.info("Received event", e);
    const eventType = event.getEventType(e);
    switch (eventType) {
      case event.EVENT_IF_UP: 
      case event.EVENT_IF_DOWN: {
        this._reapplyNeeded = true;
        this.propagateConfigChanged(true);
        pl.scheduleReapply();
        break;
      }
      default:
    }
  }

  async getIPv4Addresses() {
    const ip4s = []
    const localIp = await fs.readFileAsync(`/etc/openvpn/ovpn_server/${this.networkConfig.instance || "server"}.local`, { encoding: "utf8" })
      .then(content => content.trim())
      .catch((err) => {
        this.log.error(`Failed to read .local file for openvpn ${this.name} ${this.networkConfig.instance}`, err.message);
        return null;
      });
    if (localIp) {
      const addr = localIp.split('/')[0];
      const mask = localIp.split('/')[1] || "255.255.255.255";
      const subnet = ip.subnet(addr, mask);
      const ip4 = `${addr}/${subnet.subnetMaskLength}`;
      ip4s.push(ip4);
    }
    return ip4s;
  }

  async state() {
    // stub implementation
    const state = await super.state();
    const up = await exec(`ip link show dev ${this.name}`).then(() => true).catch(() => false);
    if (up) {
      if (this.networkConfig.type === "server") {
        const ip4s = await this.getIPv4Addresses();
        if (!_.isEmpty(ip4s)) {
          state.ip4s = ip4s;
          state.ip4 = ip4s[0];
        }
      }
    }
    if (!state.mac)
    // a place holder for mac address
      state.mac = "02:01:11:11:11:11"
    return state;
  }

}

module.exports = OpenVPNInterfacePlugin;