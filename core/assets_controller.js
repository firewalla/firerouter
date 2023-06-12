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
const ncm = require('../core/network_config_mgr.js');
const { exec } = require('child-process-promise');
const { Address4 } = require('ip-address');
const {BigInteger} = require('jsbn');
const uuid = require('uuid');

const ASSETS_EFFECTIVE_CONFIG_KEY = "assets:effective_config";
const ASSETS_CONTROL_PORT = 8838;

const MSG_PULL_CONFIG = "assets_msg::pull_config";
const MSG_PUSH_CONFIG = "assets_msg::push_config";
const MSG_AUTH_REGISTER = "assets_msg::auth_register";
const MSG_HEARTBEAT = "assets_msg::heartbeat";
const MSG_STATUS = "assets_msg::status";

const KEY_CONTROLLER_ID = "assets_controller_id";

const defaultTemplateMap = {
  ap: {
    name: "ap_default",
    value: {
      wifiNetworks: []
    }
  }
};

class AssetsController {
  constructor () {
    this.controlSocket = null;
    this.uidPublicKeyMap = {};
    this.publicKeyUidMap = {};
    this.publicKeyIpMap = {};
    this.ipPublicKeyMap = {};
    this.pushConfigTimer = {};
    return this;
  }

  async refreshEffectiveConfig(uid) {

  }

  async recordStatus(msg) {
    const mac = msg.mac;
    const devices = msg.devices;
    if (!_.isEmpty(devices)) {
      for (const device of devices) {
        device.apMac = mac;
        device.ts = Math.floor(new Date()/ 1000);
        const deviceMac = device.mac_addr;
        const key = `assets:status:${deviceMac}`;
        await rclient.setAsync(key, JSON.stringify(device), "EX", 30);
      }
    }
  }

  async pushEffectiveConfig(uid) {
    if (!this.controlSocket)
      return;
    const assetIP = this.uidPublicKeyMap[uid] && this.publicKeyIpMap[this.uidPublicKeyMap[uid]];
    if (!assetIP) {
      log.error(`Cannot find ip of asset ${uid}`);
      return;
    }
    const config = await this.getEffectiveConfig(uid);
    if (!config) {
      log.error(`Cannot find effective config of asset ${uid}`);
      return;
    }
    const msg = {type: MSG_PUSH_CONFIG, config};
    this.controlSocket.send(JSON.stringify(msg), ASSETS_CONTROL_PORT, assetIP);
  }

  async sendHeartbeat(uid) {
    if (!this.controlSocket)
      return;
    const assetIP = this.uidPublicKeyMap[uid] && this.publicKeyIpMap[this.uidPublicKeyMap[uid]];
    if (!assetIP) {
      log.error(`Cannot find IP of asset ${uid}`);
      return;
    }
    const config = await this.getEffectiveConfig(uid);
    if (!config || !config._ts) {
      log.debug(`Cannot find effective config ts of asset ${uid}`);
      return;
    }
    // heartbeat with most recent config update timestamp, the asset can send pull_config accordingly
    const msg = {type: MSG_HEARTBEAT, ts: config._ts};
    this.controlSocket.send(JSON.stringify(msg), ASSETS_CONTROL_PORT, assetIP);
  }

  async getEffectiveConfig(uid) {
    const effectiveConfig = await rclient.hgetAsync(ASSETS_EFFECTIVE_CONFIG_KEY, uid);
    if (effectiveConfig)
      return JSON.parse(effectiveConfig);
    return null;
  }

  async setEffectiveConfig(uid, config) {
    if (!_.isObject(config)) {
      log.error(`Set effective config failed on asset ${uid}, config is not an object`, config);
      return;
    }
    if (config.publicKey) {
      this.uidPublicKeyMap[uid] = config.publicKey;
      this.publicKeyUidMap[config.publicKey] = uid;
    }
    const prevEffectiveConfig = await this.getEffectiveConfig(uid);
    if (this.isEffectiveConfigEquivalent(prevEffectiveConfig, config)) {
      log.info(`Effective config of asset ${uid} is not changed, skip pushing effective config`);
      return;
    }
    const ts = Date.now() / 1000;
    config._ts = ts;
    await rclient.hsetAsync(ASSETS_EFFECTIVE_CONFIG_KEY, uid, JSON.stringify(config));
    this.schedulePushEffectiveConfig(uid);
  }

  async deleteEffectiveConfig(uid) {
    if (this.uidPublicKeyMap[uid]) {
      if (this.publicKeyUidMap[this.uidPublicKeyMap[uid]] === uid)
        delete this.publicKeyUidMap[this.uidPublicKeyMap[uid]];
      delete this.uidPublicKeyMap[uid];
    }
    await rclient.hdelAsync(ASSETS_EFFECTIVE_CONFIG_KEY, uid);
  }

  isEffectiveConfigEquivalent(cfg1, cfg2) {
    if (!_.isObject(cfg1) || !_.isObject(cfg2))
      return cfg1 == cfg2;
    const ignoredKeys = ["_ts"];
    const config1 = _.pick(cfg1, Object.keys(cfg1).filter(k => !ignoredKeys.includes(k)));
    const config2 = _.pick(cfg2, Object.keys(cfg2).filter(k => !ignoredKeys.includes(k)));
    return _.isEqual(config1, config2);
  }

  schedulePushEffectiveConfig(uid) {
    if (this.pushConfigTimer[uid]) {
      clearTimeout(this.pushConfigTimer[uid]);
    }
    this.pushConfigTimer = setTimeout(() => {
      this.pushEffectiveConfig(uid).catch((err) => {
        log.error(`Failed to push assets config ${uid}`, err.message);
      }).finally(() => {
        delete this.pushConfigTimer[uid];
      });
    }, 2000);
  }

  async startServer(wgConf, wgIntf) {
    this.stopServer();
    this.wgIntf = wgIntf;
    const peers = wgConf.peers;
    const privateKey = wgConf.privateKey;
    this.selfPublicKey = await exec(`echo ${privateKey} | wg pubkey`).then((result) => result.stdout.trim()).catch((err) => null);
    if (!_.isArray(peers)) {
      log.error(`assets wg config does not include peers`, wgConf);
      return;
    }
    const pubKeyIpMap = {};
    const ipPubKeyMap = {};
    for (const peer of peers) {
      const publicKey = peer.publicKey;
      const ip = _.isArray(peer.allowedIPs) && peer.allowedIPs[0].split('/')[0];
      pubKeyIpMap[publicKey] = ip;
      ipPubKeyMap[ip] = publicKey;
    }
    this.publicKeyIpMap = pubKeyIpMap;
    this.ipPublicKeyMap = ipPubKeyMap;
    // socket for control channel
    this.controlSocket = dgram.createSocket({
      type: "udp4",
      reuseAddr: true
    });
    this.controlSocket.on('message', this.processControlMessage.bind(this));
    this.controlSocket.on('error', (err) => {
      log.error(`Error occurred on control socket, restarting ...`, err.message);
      this.stopServer();
      this.startServer(wgConf).catch((err) => {
        log.error(`Failed to start assets controller server`, err.message);
      });
    });
    const ip = wgConf.ipv4.split('/')[0];
    this.controlSocket.bind(ASSETS_CONTROL_PORT, ip);
    // periodically send heartbeat to all peers
    this.hbInterval = setInterval(() => {
      for (const uid of Object.keys(this.uidPublicKeyMap)) {
        this.sendHeartbeat(uid);
      }
    }, 30000);
  }

  async processControlMessage(message, info) {
    message = message.toString();
    try {
      const msg = JSON.parse(message);
      switch (msg.type) {
        case MSG_PULL_CONFIG: {
          const uid = this.ipPublicKeyMap[info.address] && this.publicKeyUidMap[this.ipPublicKeyMap[info.address]];
          if (!uid) {
            log.error(`Cannot find uid of IP address ${info.address}`, message);
            return;
          }
          this.schedulePushEffectiveConfig(uid);
          break;
        }
        case MSG_STATUS: {
          await this.recordStatus(msg);
          break;
        }
        case MSG_AUTH_REGISTER: {
          const publicKey = this.ipPublicKeyMap[info.address];
          if (!publicKey) {
            log.error(`Cannot find public key of IP address ${info.address}`, message);
          }
          await this.processAuthRegister(msg, publicKey);
          break;
        }
        default: {
          log.warn(`Unsupported message type: ${msg.type}`, msg);
        }
      }
    } catch (err) {
      log.error(`Failed to handle assets control message from ${info.address}`, message, err.message);
    }
  }

  async processAuthRegister(msg, publicKey) {  
    // An asset sends a register message to register itself to controller. It includes uid of the asset, as well as the public key of the asset for control channel
    // { "type": "assets_msg::auth_register", "uid": "xx:xx:xx:xx:xx:xx", "publicKey": "xxxxxxxx" }
    const uid = msg.uid;
    if (!uid || !publicKey)
      return;
    const deviceType = msg.type || "ap";
    // write after read, need to acquire RWLock
    await ncm.acquireConfigRWLock(async () => {
      const networkConfig = await ncm.getActiveConfig();
      const template = defaultTemplateMap[deviceType];
      if (template && (!networkConfig.assets_template || !networkConfig.assets_template[template.name])) {
        networkConfig.assets_template = {};
        networkConfig.assets_template[template.name] = template.value;
      }
      let assetConfig = _.get(networkConfig, ["assets", uid]);
      if (assetConfig) {
        if (assetConfig.publicKey === publicKey && this.uidPublicKeyMap[uid] === publicKey) {
          return;
        }
        assetConfig.publicKey = publicKey;
      } else {
        // create dummy assets config
        if (!networkConfig.assets)
          networkConfig.assets = {};
        networkConfig.assets[uid] = { publicKey };
        if (template)
          Object.assign(networkConfig.assets[uid], template.value);
      }
      // update network config with updated public key and dummy config
      const errors = await ncm.tryApplyConfig(networkConfig); // this will transitively call setEffectiveConfig, which updates the uid and public key mappings
      if (errors && errors.length != 0) {
        log.error(`Failed to apply network config with dummy asset config ${uid}`, errors);
        return;
      }
      await ncm.saveConfig(networkConfig);
    });
  }

  stopServer() {
    if (this.controlSocket) {
      this.controlSocket.close();
      this.controlSocket = null;
    }
    if (this.hbInterval) {
      clearInterval(this.hbInterval);
      this.hbInterval = null;
    }
  }

  generateRandomIP(cidr) {
    const addr4 = new Address4(cidr);
    const maskLength = addr4.subnetMask;
    const randomBits = 32 - maskLength;
    const randomOffsets = 1 + Math.floor(Math.random() * (Math.pow(2, randomBits) - 2));
    return Address4.fromBigInteger(addr4.bigInteger().add(new BigInteger(randomOffsets.toString()))).correctForm() + "/32";
  }

  async getControllerID() {
    if (!this.controllerID) {
      await rclient.setAsync(KEY_CONTROLLER_ID, uuid.v4(), "NX"); // set if not exists
      this.controllerID = await rclient.getAsync(KEY_CONTROLLER_ID);
    }
    return this.controllerID;
  }
}

module.exports = new AssetsController();