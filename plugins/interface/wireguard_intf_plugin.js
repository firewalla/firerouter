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
const r = require('../../util/firerouter.js');
const fs = require('fs');
const _ = require('lodash');
const routing = require('../../util/routing.js');
const util = require('../../util/util.js');
const {Address4, Address6} = require('ip-address');


const Promise = require('bluebird');
Promise.promisifyAll(fs);

class WireguardInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    await exec(`sudo modprobe wireguard`);
    await exec(`mkdir -p ${r.getUserConfigFolder()}/wireguard`);
  }

  async flush() {
    await super.flush();
    await exec(`sudo ip link set ${this.name} down`).catch((err) => {});
    await exec(`sudo ip link del dev ${this.name}`).catch((err) => {});
    await fs.unlinkAsync(this._getInterfaceConfPath()).catch((err) => {});
    if (this.networkConfig.listenPort) {
      await exec(util.wrapIptables(`sudo iptables -w -D FR_WIREGUARD -p udp --dport ${this.networkConfig.listenPort} -j ACCEPT`)).catch((err) => {});
      await exec(util.wrapIptables(`sudo ip6tables -w -D FR_WIREGUARD -p udp --dport ${this.networkConfig.listenPort} -j ACCEPT`)).catch((err) => {});
      await exec(util.wrapIptables(`sudo iptables -w -t nat -D FR_WIREGUARD -p udp --dport ${this.networkConfig.listenPort} -j ACCEPT`)).catch((err) => {});
      await exec(util.wrapIptables(`sudo ip6tables -w -t nat -D FR_WIREGUARD -p udp --dport ${this.networkConfig.listenPort} -j ACCEPT`)).catch((err) => {});
    }
  }

  _getInterfaceConfPath() {
    return `${r.getUserConfigFolder()}/wireguard/${this.name}.conf`;
  }

  async createInterface() {
    await exec(`sudo ip link add dev ${this.name} type wireguard`).catch((err) => {});
    if (!this.networkConfig.privateKey)
      this.fatal(`Private key is not specified for Wireguard interface ${this.name}`);
    // [Interface] section
    const entries = ["[Interface]"];
    entries.push(`PrivateKey = ${this.networkConfig.privateKey}`);
    if (this.networkConfig.listenPort) {
      entries.push(`ListenPort = ${this.networkConfig.listenPort}`);
      if (this.networkConfig.enabled) {
        await exec(util.wrapIptables(`sudo iptables -w -A FR_WIREGUARD -p udp --dport ${this.networkConfig.listenPort} -j ACCEPT`)).catch((err) => {});
        await exec(util.wrapIptables(`sudo ip6tables -w -A FR_WIREGUARD -p udp --dport ${this.networkConfig.listenPort} -j ACCEPT`)).catch((err) => {});
        await exec(util.wrapIptables(`sudo iptables -w -t nat -A FR_WIREGUARD -p udp --dport ${this.networkConfig.listenPort} -j ACCEPT`)).catch((err) => {});
        await exec(util.wrapIptables(`sudo ip6tables -w -t nat -A FR_WIREGUARD -p udp --dport ${this.networkConfig.listenPort} -j ACCEPT`)).catch((err) => {});
      }
    }
    entries.push('\n');

    if (_.isArray(this.networkConfig.peers)) {
      // [Peer] section
      for (const peer of this.networkConfig.peers) {
        if (!peer.publicKey)
          this.fatal(`publicKey of peer in Wireguard interface ${this.name} is not specified`);
        entries.push("[Peer]");
        entries.push(`PublicKey = ${peer.publicKey}`);
        if (peer.presharedKey)
          entries.push(`PresharedKey = ${peer.presharedKey}`);
        if (peer.endpoint)
          entries.push(`Endpoint = ${peer.endpoint}`);
        if (_.isArray(peer.allowedIPs) && !_.isEmpty(peer.allowedIPs))
          entries.push(`AllowedIPs = ${peer.allowedIPs.join(", ")}`);
        if (peer.persistentKeepalive)
          entries.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
        entries.push('\n');
      }
    }
    await fs.writeFileAsync(this._getInterfaceConfPath(), entries.join('\n'), {encoding: 'utf8'});
    await exec(`sudo wg setconf ${this.name} ${this._getInterfaceConfPath()}`);
    return true;
  }

  async changeRoutingTables() {
    await super.changeRoutingTables();
    if (_.isArray(this.networkConfig.peers)) {
      for (const peer of this.networkConfig.peers) {
        if (peer.allowedIPs) {
          for (const allowedIP of peer.allowedIPs) {
            if (this.isLAN()) {
              // add peer networks to wan_routable and lan_routable
              await routing.addRouteToTable(allowedIP, null, this.name, routing.RT_LAN_ROUTABLE, null, new Address4(allowedIP).isValid() ? 4 : 6).catch((err) => {});
              await routing.addRouteToTable(allowedIP, null, this.name, routing.RT_WAN_ROUTABLE, null, new Address4(allowedIP).isValid() ? 4 : 6).catch((err) => {});
            }
            if (this.isWAN()) {
              // add peer networks to interface default routing table
              await routing.addRouteToTable(allowedIP, null, this.name, `${this.name}_default`, null, new Address4(allowedIP).isValid() ? 4 : 6).catch((err) => {});
            }
          }
        }
      }
    }
  }

  async state() {
    const state = await super.state();
    if (!state.mac)
      state.mac = "02:01:22:22:22:22";
    return state;
  }
}

module.exports = WireguardInterfacePlugin;