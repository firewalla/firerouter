/*    Copyright 2019-2023 Firewalla Inc.
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

const log = require('../util/logger.js')(__filename);
const rclient = require('../util/redis_manager').getRedisClient();
const _ = require('lodash');
const dgram = require('dgram');

const ASSETS_CONFIG_KEY = "assets:config";
const ASSETS_CONTROL_PORT = 8838;

const MSG_PULL_CONFIG = "assets_msg::pull_config";
const MSG_PUSH_CONFIG = "assets_msg::push_config";
const MSG_HEARTBEAT = "assets_msg::heartbeat";

class AssetsController {
  constructor () {
    this.socket = null;
    this.uidIpMap = {};
    this.ipUidMap = {};
    this.uidConfigMap = {};
  }

  async setConfig(uid, config) {
    if (!_.isObject(config)) {
      log.error(`Set config failed on asset ${uid}, config is not an object`, config);
      return;
    }
    const ts = Date.now() / 1000;
    config._ts = ts;
    this.uidConfigMap[uid] = config;
    await rclient.hsetAsync(ASSETS_CONFIG_KEY, uid, JSON.stringify(config));
    await this.pushConfig(uid);
  }

  async getConfig(uid) {
    if (!this.uidConfigMap[uid]) {
      const str = await rclient.hgetAsync(ASSETS_CONFIG_KEY, uid);
      if (str)
        this.uidConfigMap[uid] = JSON.parse(str);
    }
    return this.uidConfigMap[uid];
  }

  async getAllConfig() {
    const result = {};
    for (const uid of Object.keys(this.uidIpMap)) {
      const config = await this.getConfig(uid);
      if (config)
        result[uid] = config;
    }
    return result;
  }

  async deleteConfig(uid) {
    const config = await this.getConfig(uid);
    await rclient.hdelAsync(ASSETS_CONFIG_KEY, uid);
    delete this.uidConfigMap[uid];
    return config;
  }

  async pushConfig(uid) {
    if (!this.socket)
      return;
    const assetIP = this.uidIpMap[uid];
    if (!assetIP) {
      log.error(`Cannot find ip of asset ${uid}`);
      return;
    }
    const config = await this.getConfig(uid);
    if (!config) {
      log.error(`Cannot find config of asset ${uid}`);
      return;
    }
    const msg = {type: MSG_PUSH_CONFIG, config};
    this.socket.send(JSON.stringify(msg), ASSETS_CONTROL_PORT, assetIP);
  }

  async sendHeartbeat(uid) {
    if (!this.socket)
      return;
    const assetIP = this.uidIpMap[uid];
    if (!assetIP) {
      log.error(`Cannot find IP of asset ${uid}`);
      return;
    }
    const config = await this.getConfig(uid);
    if (!config || !config._ts) {
      log.debug(`Cannot find config ts of asset ${uid}`);
      return;
    }
    // heartbeat with most recent config update timestamp, the asset can send pull_config accordingly
    const msg = {type: MSG_HEARTBEAT, ts: config._ts};
    this.socket.send(JSON.stringify(msg), ASSETS_CONTROL_PORT, assetIP);
  }

  startServer(wgConf) {
    if (this.socket) {
      this.stopServer();
    }
    const peers = wgConf.peers;
    if (!_.isArray(peers)) {
      log.error(`assets wg config does not include peers`, wgConf);
      return;
    }
    for (const peer of peers) {
      const publicKey = peer.publicKey;
      const assetIP = _.isArray(peer.allowedIPs) && peer.allowedIPs[0].split('/')[0];
      this.uidIpMap[publicKey] = assetIP;
      this.ipUidMap[assetIP] = publicKey;
    }
    this.socket = dgram.createSocket({
      type: "udp4",
      reuseAddr: true
    });
    this.socket.on('message', async (message, info) => {
      message = message.toString();
      const uid = this.ipUidMap[info.address];
      if (!uid) {
        log.error(`Cannot find uid of IP address ${info.address}`);
        return;
      }
      try {
        const msg = JSON.parse(message);
        switch (msg.type) {
          case MSG_PULL_CONFIG : {
            await this.pushConfig(uid);
            break;
          }
          default: {
            log.warn(`Unsupported message type: ${msg.type}`, msg);
          }
        }
      } catch (err) {
        log.error(`Failed to handle asset message from ${info.address}`, message, err.message);
      }
    });
    this.socket.on('error', (err) => {
      log.error(`Error occurred on UDP socket, restarting ...`, err.message);
      this.stopServer();
      this.startServer(wgConf);
    });
    const ip = wgConf.ipv4.split('/')[0];
    this.socket.bind(ASSETS_CONTROL_PORT, ip);
    // periodically send heartbeat to all peers
    this.hbInterval = setInterval(() => {
      for (const peer of peers) {
        this.sendHeartbeat(peer.publicKey);
      }
    }, 30000);
  }

  stopServer() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    if (this.hbInterval) {
      clearInterval(this.hbInterval);
      this.hbInterval = null;
    }
  }
}

module.exports = new AssetsController();