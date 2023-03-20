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
const pl = require('../plugin_loader.js');
const event = require('../../core/event.js');

const bindIntfRulePriority = 6001;

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

      await this._resetBindIntfRule().catch((err) => {});
    }
  }

  async _resetBindIntfRule() {
    const bindIntf = this._bindIntf;
    const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
    if(bindIntf) {
      await routing.removePolicyRoutingRule("all", "lo", `${bindIntf}_default`, bindIntfRulePriority, `${rtid}/${routing.MASK_REG}`, 4).catch((err) => {});
      await routing.removePolicyRoutingRule("all", "lo", `${bindIntf}_default`, bindIntfRulePriority, `${rtid}/${routing.MASK_REG}`, 6).catch((err) => {});
    } else {
      await routing.removePolicyRoutingRule("all", "lo", routing.RT_GLOBAL_DEFAULT, bindIntfRulePriority, `${rtid}/${routing.MASK_REG}`, 4).catch((err) => {});
      await routing.removePolicyRoutingRule("all", "lo", routing.RT_GLOBAL_DEFAULT, bindIntfRulePriority, `${rtid}/${routing.MASK_REG}`, 6).catch((err) => {});
    }
    this._bindIntf = null;
  }

  _getInterfaceConfPath() {
    return `${r.getUserConfigFolder()}/wireguard/${this.name}.conf`;
  }

  getDefaultMTU() {
    //  The overhead of WireGuard breaks down as follows:
    // - 20-byte IPv4 header or 40 byte IPv6 header
    // - 8-byte UDP header
    // - 4-byte type
    // - 4-byte key index
    // - 8-byte nonce
    // - 16-byte authentication tag
    // in case of pppoe + ipv6, it will be 1492 - 40 - 8 - 4 - 4 - 8 - 16 = 1412
    return 1412;
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
    // add FwMark option in [Interface] config for WAN selection
    const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
    entries.push(`FwMark = ${rtid}`)
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
        if (peer.endpoint) {
          const host = peer.endpoint.substring(0, peer.endpoint.lastIndexOf(':'));
          // do not set Endpoint with domain, dns may be unavailable at the moment, causing wg setconf return error, domain will be resolved later in automata
          if ((host.startsWith('[') && host.endsWith(']') && new Address6(host.substring(1, host.length - 1)).isValid()) || new Address4(host).isValid())
            entries.push(`Endpoint = ${peer.endpoint}`);
        }
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
            // route for allowed IP has a lower priority, in case there are conflicts between allowedIPs and other LAN IPs
            await routing.addRouteToTable(allowedIP, null, this.name, "main", 512, new Address4(allowedIP).isValid() ? 4 : 6).catch((err) => {});
            if (this.isLAN()) {
              // add peer networks to wan_routable and lan_routable
              await routing.addRouteToTable(allowedIP, null, this.name, routing.RT_LAN_ROUTABLE, 512, new Address4(allowedIP).isValid() ? 4 : 6).catch((err) => {});
              await routing.addRouteToTable(allowedIP, null, this.name, routing.RT_WAN_ROUTABLE, 512, new Address4(allowedIP).isValid() ? 4 : 6).catch((err) => {});
            }
            if (this.isWAN()) {
              // add peer networks to interface default routing table
              await routing.addRouteToTable(allowedIP, null, this.name, `${this.name}_default`, 512, new Address4(allowedIP).isValid() ? 4 : 6).catch((err) => {});
            }
          }
        }
      }
    }

    await this._resetBindIntfRule().catch((err) => {});
    // add specific routing for wireguard outgoing packets
    let bindIntf = this.networkConfig.bindIntf;
    if (!bindIntf) {
      const routingPlugin = pl.getPluginInstance("routing", "global");
      if (routingPlugin) {
        this.subscribeChangeFrom(routingPlugin);
        const wanIntfPlugins = routingPlugin.getActiveWANPlugins();
        if (_.isArray(wanIntfPlugins) && !_.isEmpty(wanIntfPlugins)) {
          bindIntf = wanIntfPlugins[0].name;
        } else {
          const wanIntfPlugin = routingPlugin.getPrimaryWANPlugin();
          bindIntf = wanIntfPlugin && wanIntfPlugin.name;
        }
      }
    }
    const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
    if (bindIntf) {
      this.log.info(`Wireguard ${this.name} will bind to WAN ${bindIntf}`);
      await routing.createPolicyRoutingRule("all", "lo", `${bindIntf}_default`, bindIntfRulePriority, `${rtid}/${routing.MASK_REG}`, 4).catch((err) => { });
      await routing.createPolicyRoutingRule("all", "lo", `${bindIntf}_default`, bindIntfRulePriority, `${rtid}/${routing.MASK_REG}`, 6).catch((err) => { });
      this._bindIntf = bindIntf;
    } else {
      await routing.createPolicyRoutingRule("all", "lo", routing.RT_GLOBAL_DEFAULT, bindIntfRulePriority, `${rtid}/${routing.MASK_REG}`, 4).catch((err) => { });
      await routing.createPolicyRoutingRule("all", "lo", routing.RT_GLOBAL_DEFAULT, bindIntfRulePriority, `${rtid}/${routing.MASK_REG}`, 6).catch((err) => { });
      this._bindIntf = null;
    }
  }

  async state() {
    const state = await super.state();
    if (!state.mac)
      state.mac = "02:01:22:22:22:22";
    return state;
  }

  onEvent(e) {
    super.onEvent(e);
    const eventType = event.getEventType(e);
    if (eventType === event.EVENT_WAN_SWITCHED) {
      this._reapplyNeeded = true;
      pl.scheduleReapply();
    }
  }
}

module.exports = WireguardInterfacePlugin;