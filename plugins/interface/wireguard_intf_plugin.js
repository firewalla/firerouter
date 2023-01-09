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
    if (this._automata) {
      this._automata.stop();
      delete this._automata;
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

    if (this.networkConfig.autonomous) {
      const pubKey = await exec(`echo ${this.networkConfig.privateKey} | wg pubkey`).then(result => result.stdout.trim()).catch((err) => {
        this.log.error(`Failed to parse private key to public key`);
        return null;
      })
      if (pubKey) {
        this._automata = new WireguardMeshAutomata(this.name, pubKey, this.networkConfig);
        this._automata.start();
      }
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

const dgram = require('dgram');

const CTRLMessages = {
  PEER_ENDPOINT_INFO: "msg:peer_endpoint_info",
  ROUTE_REQUEST: "msg:route_request",
  ROUTE_DECISION: "msg:route_decision"
};
const LOCK_PEER_INFO = "lock_peer_info";
const AsyncLock = require('async-lock');
const lock = new AsyncLock();

const T0 = 150;
const T1 = 180;
const T2 = 225;

class WireguardMeshAutomata {
  constructor(intf, pubKey, config) {
    // config should be the network config of the intf
    this.intf = intf;
    this.pubKey = pubKey;
    this.config = config;
    this.peerInfo = {};
    this.effectiveAllowedIPs = {};
    const ipv4 = this.config.ipv4;
    const cidr = new Address4(ipv4);
    for (const peer of this.config.peers) {
      const allowedIPs = peer.allowedIPs || [];
      const peerIP = allowedIPs.find(ip => {
        const ip4 = new Address4(ip);
        return ip4.isValid() && ip4.isInSubnet(cidr);
      });
      this.peerInfo[peer.publicKey] = {
        peerIP: peerIP,
        allowedIPs : allowedIPs,
        router: null,
        connected: []
      };
      // effective allowed IPs is set to original allowed IPs at first
      this.effectiveAllowedIPs[peer.publicKey] = allowedIPs;
    }
    this.log = require('../../util/logger.js')(`WireguardMeshAutomata:${this.intf}`);
  }

  start() {
    this.socket = dgram.createSocket({
      type: "udp4",
      reuseAddr: true
    });
    this.socket.on('message', async (message, info) => {
      message = message.toString();
      try {
        const msg = JSON.parse(message);
        const from = msg.from;
        if (!from || !this.peerInfo[from]) {
          this.log.error(`Received message from an unknown peer ${from}, ignore`);
          return;
        }
        switch (msg.type) {
          case CTRLMessages.PEER_ENDPOINT_INFO: {
            await lock.acquire(LOCK_PEER_INFO, async () => {
              await this.handlePeerEndpointInfoMsg(msg).catch((err) => {
                this.log.error(`Failed to handle peer endpoint info message`, err.message);
              });
            }).catch((err) => {});
            break;
          }
          case CTRLMessages.ROUTE_REQUEST: {
            await this.handleRouteRequestMsg(msg).catch((err) => {
              this.log.error(`Failed to handle route request message`, err.message);
            });
            break;
          }
          case CTRLMessages.ROUTE_DECISION: {
            await lock.acquire(LOCK_PEER_INFO, async () => {
              await this.handleRouteDecisionMsg(msg).catch((err) => {
                this.log.error(`Failed to handle route decision message`, err.message);
              });
            }).catch((err) => {});
            break;
          }
          default:
            this.log.error(`Unknown message type ${msg.type} from peer ${from}, ignore`);
        }
      } catch (err) {
        this.log.error(`Failed to handle peer status msg from ${info.address}`, message, err.message);
      }
    });
    this.socket.on('error', (err) => {
      this.log.error(`Error occured on UDP socket, will create a new one`, err.message);
      setTimeout(() => {
        this.stop();
        this.start();
      }, 5000);
    })
    const ip = this.config.ipv4.split('/')[0];
    this.socket.bind(6666, ip);
    this._lastSendTs = 0;
    this.sendStatusInterval = setInterval(() => {
      this.sendPeerEndpointInfoMsg().catch((err) => {
        this.log.error(`Failed to send peer endpoint info message`, err.message);
      });
    }, 15000);
    this.reapplyInterval = setInterval(() => {
      lock.acquire(LOCK_PEER_INFO, async () => {
        await this.reapply().catch((err) => {
          this.log.error(`Failed to reapply peer info`, err.message);
        });
      }).catch((err) => {});
    }, 19000); // 15 and 19 are co-prime
  }

  stop() {
    if (this.reapplyInterval) {
      clearInterval(this.reapplyInterval);
      this.reapplyInterval = null;
    }
    if (this.sendStatusInterval) {
      clearInterval(this.sendStatusInterval);
      this.sendStatusInterval = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  async sendPeerEndpointInfoMsg() {
    const dumpResult = await exec(`sudo wg show ${this.intf} dump | tail +2`).then(result => result.stdout.trim().split('\n')).catch((err) => {
      this.log.error(`Failed to dump wireguard peers on ${this.intf}`, err.message);
      return null;
    });
    const peers = {};
    const now = Date.now() / 1000;
    if (_.isArray(dumpResult)) {
      for (const line of dumpResult) {
        try {
          let [pubKey, psk, endpoint, allowedIPs, latestHandshake, rxBytes, txBytes, keepalive] = line.split('\t');
          latestHandshake = Number(latestHandshake);
          if (now - latestHandshake < T0) {
            if (endpoint) {
              if (endpoint.startsWith("[")) {
                // ipv6 address
                const v6 = endpoint.substring(1, endpoint.indexOf("]"));
                const port = Number(endpoint.substring(endpoint.indexOf("]") + 2));
                peers[pubKey] = { v6, port, ts6: latestHandshake };
              } else {
                // ipv4 address
                const v4 = endpoint.substring(0, endpoint.indexOf(":"));
                const port = Number(endpoint.substring(endpoint.indexOf(":") + 1));
                peers[pubKey] = { v4, port, ts4: latestHandshake };
              }
            }
          }
        } catch (err) {
          this.log.error(`Failed to parse dump result ${line}`, err.message);
        }
      }
    }
    const msg = {type: CTRLMessages.PEER_ENDPOINT_INFO, from: this.pubKey, asRouter: this.config.asRouter || false, peers};
    if (Object.keys(peers).length != 0 && (!_.isEqual(msg, this._lastSentMsg) || now - this._lastSendTs > 120)) { // do not send same peer status in 120 seconds
      const str = JSON.stringify(msg);
      this.log.debug("Send status message: ", str);
      for (const pubKey of Object.keys(this.peerInfo)) {
        const info = this.peerInfo[pubKey];
        const peerIP = info.peerIP;
        if (peerIP) {
          this.socket.send(str, 6666, peerIP.split('/')[0]);
        }
      }
      this._lastSentMsg = msg;
      this._lastSendTs = now;
    }
  }

  async handleRouteDecisionMsg(msg) {
    const { from, to, router } = msg;
    const toInfo = this.peerInfo[to];
    if (!toInfo) {
      this.log.error(`Unknown to peer in route decision message: ${to}`, msg);
      return;
    }
    const rInfo = this.peerInfo[router];
    if (!rInfo) {
      this.log.error(`Unknown router peer in route decision message: ${router}`, msg);
      return;
    }
    if (!rInfo.asRouter) {
      this.log.error(`Peer ${router} should not be used as a router, invalid route decision message: `, msg);
      return;
    }
    this.log.info(`Use peer ${router} as relay node for peer ${to} from route decision message`)
    toInfo.router = router; // do not enforce allowed IPs immediately, it will be enforced in periodical reapply
  }

  async handleRouteRequestMsg(msg) {
    const { from, to, router } = msg;
    if (router != this.pubKey) {
      this.log.error(`Straying route request message with wrong router`, msg);
      return;
    }
    if (!this.config.asRouter) {
      this.log.error(`'asRouter' is false, ignore route request message`, msg);
      return;
    }
    const toInfo = this.peerInfo[to];
    if (!toInfo) {
      this.log.error(`Unknown to peer in route request message: ${to}`, msg);
      return;
    }
    const peerIP = toInfo.peerIP;
    const routeDecisionMsg = { from: router, to: from, router: router, type: CTRLMessages.ROUTE_DECISION };
    if (peerIP)
      this.socket.send(JSON.stringify(routeDecisionMsg), 6666, peerIP.split('/')[0]);
  }

  async handlePeerEndpointInfoMsg(msg) {
    const peers = msg.peers || {};
    const asRouter = msg.asRouter || false;
    const now = Date.now() / 1000;
    const connectedPeers = [];
    for (const key of Object.keys(peers)) {
      if (!this.peerInfo[key])
        continue;
      const v4 = peers[key].v4;
      const v6 = peers[key].v6;
      const ts4 = peers[key].ts4 || 0;
      const ts6 = peers[key].ts6 || 0;
      const oldTs4 = this.peerInfo[key].ts4 || 0;
      const oldTs6 = this.peerInfo[key].ts6 || 0;
      const port = peers[key].port;
      let connected = false;
      // update v4/v6 with latest handshake timestamp
      if (v4) {
        if (ts4 > oldTs4) {
          this.peerInfo[key].v4 = v4;
          this.peerInfo[key].ts4 = ts4;
          if (port)
            this.peerInfo[key].port = port;
        }
        if (now - ts4 <= T1)
          connected = true;
      }
      if (v6) {
        if (ts6 > oldTs6) {
          this.peerInfo[key].v6 = v6;
          this.peerInfo[key].ts6 = ts6;
          if (port)
            this.peerInfo[key].port = port;
        }
        if (now - ts6 <= T1)
          connected = true;
      }
      if (connected)
        connectedPeers.push(key);
    }
    const from = msg.from;
    this.peerInfo[from].connected = connectedPeers;
    this.peerInfo[from].asRouter = asRouter;
    this.log.debug("Current peer info: ", this.peerInfo);
  }

  async reapply() {
    const dumpResult = await exec(`sudo wg show ${this.intf} dump | tail +2`).then(result => result.stdout.trim().split('\n')).catch((err) => {
      this.log.error(`Failed to dump wireguard peers on ${this.intf}`, err.message);
      return null;
    });
    const now = Date.now() / 1000;
    let v6Supported = false;
    if (this.config.bindIntf) {
      v6Supported = await exec(`ip -6 r show default table ${this.config.bindIntf}_default`).then(result => !_.isEmpty(result.stdout.trim())).catch((err) => false);
    } else {
      v6Supported = await exec(`ip -6 r show default table global_default`).then(result => !_.isEmpty(result.stdout.trim())).catch((err) => false);
    }
    const t0Peers = [];
    const t1Peers = [];
    const t2Peers = [];
    if (_.isArray(dumpResult)) {
      for (const line of dumpResult) {
        try {
          let [pubKey, psk, endpoint, allowedIPs, latestHandshake, rxBytes, txBytes, keepalive] = line.split('\t');
          latestHandshake = Number(latestHandshake);
          const info = this.peerInfo[pubKey];
          if (!info)
            continue;
          if (now - latestHandshake <= T0)
            t0Peers.push(pubKey);
          else {
            if (now - latestHandshake > T1)
              t1Peers.push(pubKey);
            if (now - latestHandshake > T2)
              t2Peers.push(pubKey);
          }
        } catch (err) {
          this.log.error(`Failed to parse dump result ${line}`, err.message);
        }
      }

      // peers in t0Peers are considered as connected, no need to relay this peer
      for (const pubKey of t0Peers) {
        const info = this.peerInfo[pubKey];
        if (info.router) {
          this.log.info(`Peer ${pubKey} is connected, unset relay node ${info.router}`);
          info.router = null;
        }
      }
      
      // check 'router' of each peer is still valid
      for (const pubKey of Object.keys(this.peerInfo)) {
        const info = this.peerInfo[pubKey];
        if (info.router) {
          // peers in t1Peers are considered as disconnected, these peers can not be used as relay node
          if (t1Peers.includes(info.router)) {
            this.log.info(`Peer ${info.router} is not connected, unset it as relay node for peer ${pubKey}`);
            info.router = null;
            continue;
          }
          const rinfo = this.peerInfo[info.router];
          if (rinfo) {
            // if relay node is no longer connected to this peer, unset 'router in this peer
            if (!rinfo.connected.includes(pubKey)) {
              this.log.info(`Peer ${info.router} is not connected to peer ${pubKey}, unset it as relay node`);
              info.router = null;
              continue;
            }
            if (!rinfo.asRouter) {
              this.log.info(`Peer ${info.router} does not want to be used as router, unset it as relay node of peer ${pubKey}`);
              info.router = null;
            }
          }
        }
      }
      // learn endpoint from other connected peers
      for (const pubKey of t1Peers) {
        // change endpoint to something that is learnt from another peer
        const info = this.peerInfo[pubKey];
        const ts4 = info.ts4 || 0;
        const ts6 = info.ts6 || 0;
        if (info && info.port) {
          // do not change peer endpoint if handshake ts is earlier than local latest-handshake
          if (v6Supported && info.v6 && ts6 > now - T1) {
            this.log.info(`Changing peer ${pubKey} endpoint to [${info.v6}]:${info.port}`);
            await exec(`sudo wg set ${this.intf} peer ${pubKey} endpoint [${info.v6}]:${info.port}`).catch((err) => {});
          } else {
            if (info.v4 && ts4 > now - T1) {
              this.log.info(`Changing peer ${pubKey} endpoint to ${info.v4}:${info.port}`);
              await exec(`sudo wg set ${this.intf} peer ${pubKey} endpoint ${info.v4}:${info.port}`).catch((err) => {});
            }
          }
        }
      }

      // peers in t2Peers are disconnected for a longer time, need to find a relay node if 'router' is not set yet
      for (const pubKey of t2Peers) {
        const info = this.peerInfo[pubKey];
        // the peer with smaller public key in alphabetic order initiates the relay request
        if (this.pubKey < pubKey && !info.router) {
          const routerPeer = t0Peers.find(k => this.peerInfo[k] && this.peerInfo[k].asRouter && this.peerInfo[k].connected.includes(pubKey));
          if (!routerPeer)
            this.log.error(`Cannot find a relay node for peer ${pubKey}`);
          else {
            info.router = routerPeer;
            this.log.info(`Use peer ${routerPeer} as relay node for peer ${pubKey}`);
          }
        }
      }
      
      // calculate and enforce allowed IPs on peers based on original allowed IPs and router
      await this.enforceAllowedIPsAndSendRouteReqMsg().catch((err) => {});
    }
  }

  async enforceAllowedIPsAndSendRouteReqMsg() {
    const effectiveAllowedIPs = {};
    const routeReqMsg = [];
    for (const pubKey of Object.keys(this.peerInfo)) {
      if (!effectiveAllowedIPs[pubKey])
        effectiveAllowedIPs[pubKey] = [];
      const info = this.peerInfo[pubKey];
      if (!info.router) {
        Array.prototype.push.apply(effectiveAllowedIPs[pubKey], info.allowedIPs);
      } else {
        if (!effectiveAllowedIPs[info.router])
          effectiveAllowedIPs[info.router] = [];
        Array.prototype.push.apply(effectiveAllowedIPs[info.router], info.allowedIPs);
        if (this.pubKey < pubKey) {
          routeReqMsg.push({from: this.pubKey, to: pubKey, router: info.router, type: CTRLMessages.ROUTE_REQUEST});
        }
      }
    }
    for (const pubKey of Object.keys(this.peerInfo)) {
      const allowedIPs = effectiveAllowedIPs[pubKey].sort();
      const previousAllowedIPs = this.effectiveAllowedIPs[pubKey].sort();
      if (!_.isEqual(allowedIPs, previousAllowedIPs)) {
        const str = `"${allowedIPs.join(",")}"`;
        this.log.info(`Setting allowed IPs of ${pubKey} to ${str}`);
        await exec(`sudo wg set ${this.intf} peer ${pubKey} allowed-ips ${str}`).catch((err) => {});
      }
    }
    this.effectiveAllowedIPs = effectiveAllowedIPs;
    for (const msg of routeReqMsg) {
      const peerIP = this.peerInfo[msg.router].peerIP;
      if (peerIP) {
        this.socket.send(JSON.stringify(msg), 6666, peerIP.split('/')[0]);
      }
    }
  }
}