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
const ASSETS_AUTH_PORT = 8839;

const MSG_PULL_CONFIG = "assets_msg::pull_config";
const MSG_PUSH_CONFIG = "assets_msg::push_config";
const MSG_AUTH_REGISTER = "assets_msg::auth_register";
const MSG_RAW_AUTH_REGISTER = "assets_msg::raw_auth_register";
const MSG_RAW_AUTH_GRANT = "assets_msg::raw_auth_grant";
const MSG_HEARTBEAT = "assets_msg::heartbeat";
const MSG_STATUS = "assets_msg::status";
const MSG_BSS_STEER = "assets_msg::steer";

const KEY_STA_STATUS = "assets:ap_sta_status";
const KEY_ASSETS_STATUS = "assets:status";
const TIMEOUT_STA_STATUS = 30;

const KEY_CONTROLLER_ID = "assets_controller_id";

const defaultTemplateMap = {
  ap: {
    key: "ap_default",
    value: {
      meta: {
        name: "Default AP Group"
      },
      wifiNetworks: []
    }
  }
};

class AssetsController {
  constructor () {
    this.controlSocket = null;
    this.authSocket = null;
    this.uidPublicKeyMap = {};
    this.publicKeyUidMap = {};
    this.publicKeyIpMap = {};
    this.ipPublicKeyMap = {};
    this.pubKeyPrivKeyMap = {};
    this.pushConfigTimer = {};
    return this;
  }

  async refreshEffectiveConfig(uid) {

  }

  async getAPSTAStutus(staMAC) {
    const result = await rclient.hgetAsync(KEY_STA_STATUS, staMAC);
    if (result) {
      try {
        const obj = JSON.parse(result);
        return obj;
      } catch (err) {
        log.error(`Failed to parse sta status of ${staMAC}`, err.message);
      }
    }
    return null;
  }

  async getAllAPSTAStatus() {
    const result = await rclient.hgetallAsync(KEY_STA_STATUS) || {};
    const keysToDelete = [];
    for (const key of Object.keys(result)) {
      try {
        const obj = JSON.parse(result[key]);
        if (obj.ts && obj.ts >= Date.now() / 1000 - TIMEOUT_STA_STATUS)
          result[key] = obj;
        else {
          delete result[key];
          keysToDelete.push(key);
        }
      } catch (err) {
        log.error(`Failed to parse sta status of ${key}`, err.message);
      }
    }
    if (!_.isEmpty(keysToDelete))
      await rclient.hdelAsync(KEY_STA_STATUS, ...keysToDelete);
    return result;
  }

  async getAPAssetsStatus(uid) {
    const result = await rclient.hgetAsync(KEY_ASSETS_STATUS, uid);
    if (result) {
      try {
        const obj = JSON.parse(result);
        return obj;
      } catch (err) {
        log.error(`Failed to parse assets status of ${uid}`, err.message);
      }
    }
    return null;
  }

  async getAllAPAssetsStatus() {
    const result = await rclient.hgetallAsync(KEY_ASSETS_STATUS) || {};
    const keysToDelete = [];
    for (const key of Object.keys(result)) {
      try {
        if (this.uidPublicKeyMap[key]) {
          const obj = JSON.parse(result[key]);
          result[key] = obj;
        } else {
          delete result[key];
          keysToDelete.push(key);
        }
      } catch (err) {
        log.error(`Failed to parse assets status of ${key}`, err.message);
      }
    }
    if (!_.isEmpty(keysToDelete))
      await rclient.hdelAsync(KEY_STA_STATUS, ...keysToDelete);
    return result;
  }

  async processStatusMsg(msg, uid) {
    const mac = msg.mac;
    const devices = msg.devices;
    const aps = msg.aps || {};
    const essChannelBssMap = {};
    for (const essid of Object.keys(aps)) {
      if (!_.isArray(aps[essid]))
        continue;
      const bssInfos = aps[essid];
      for (const bssInfo of bssInfos) {
        if (bssInfo.bssid && bssInfo.intf && bssInfo.band)
          essChannelBssMap[`${essid}@${bssInfo.intf}`] = {bssid: bssInfo.bssid, band: bssInfo.band};
      }
    }
    if (!_.isEmpty(devices)) {
      for (const device of devices) {
        device.assetUID = uid;
        if (device.ssid && device.intf) {
          const key = `${device.ssid}@${device.intf}`;
          if (essChannelBssMap[key]) {
            device.bssid = essChannelBssMap[key].bssid;
            device.band = essChannelBssMap[key].band;
          }
        }
        device.ts = Math.floor(new Date()/ 1000);
        if (_.isString(device.mac_addr) && !_.isEmpty(device.mac_addr)) {
          const deviceMac = device.mac_addr.toUpperCase();
          delete device.mac_addr;
          await rclient.hsetAsync(KEY_STA_STATUS, deviceMac, JSON.stringify(device));
        }
      }
    }

    if (mac) {
      const assetsStatus = {ts: Date.now() / 1000, mac: mac, sysUptime: msg.uptime, procUptime: msg.process_uptime, version: msg.version, channelUtilization: msg.util, wanMode: msg.wanMode, upstreamAPs: msg.upstreamAPs, aps: msg.aps};
      await rclient.hsetAsync(KEY_ASSETS_STATUS, mac, JSON.stringify(assetsStatus));
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
    const pubKey = this.uidPublicKeyMap[uid];
    const channelConfig = {boxPubKey: this.selfPublicKey, boxIp: this.selfIP, boxListenPort: this.wgListenPort, pubKey: pubKey, privKey: this.pubKeyPrivKeyMap[pubKey], ip: assetIP, endpoint: `fire.walla:${this.wgListenPort}`};
    const msg = {type: MSG_PUSH_CONFIG, config: Object.assign({}, config, {wg: channelConfig})};
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
    this.wgListenPort = wgConf.listenPort;
    const peers = wgConf.peers;
    const extraPeers = wgConf.extra && wgConf.extra.peers;
    const privateKey = wgConf.privateKey;
    this.selfPublicKey = await exec(`echo ${privateKey} | wg pubkey`).then((result) => result.stdout.trim()).catch((err) => null);
    if (!_.isArray(peers)) {
      log.error(`assets wg config does not include peers`, wgConf);
      return;
    }
    const pubKeyIpMap = {};
    const ipPubKeyMap = {};
    const pubKeyPrivKeyMap = {};
    for (const peer of peers) {
      const publicKey = peer.publicKey;
      const ip = _.isArray(peer.allowedIPs) && peer.allowedIPs[0].split('/')[0];
      pubKeyIpMap[publicKey] = ip;
      ipPubKeyMap[ip] = publicKey;
    }
    for (const peer of extraPeers) {
      const {publicKey, privateKey} = peer;
      if (publicKey && privateKey)
        pubKeyPrivKeyMap[publicKey] = privateKey;
    }
    this.publicKeyIpMap = pubKeyIpMap;
    this.ipPublicKeyMap = ipPubKeyMap;
    this.pubKeyPrivKeyMap = pubKeyPrivKeyMap;
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
    this.selfIP = ip;
    this.controlSocket.bind(ASSETS_CONTROL_PORT, ip);
    // periodically send heartbeat to all peers
    this.hbInterval = setInterval(() => {
      for (const uid of Object.keys(this.uidPublicKeyMap)) {
        this.sendHeartbeat(uid);
      }
    }, 30000);
    // socket for raw authentication
    this.authSocket = dgram.createSocket({
      type: "udp4",
      reuseAddr: true
    });
    this.authSocket.on('message', this.processRawAuthMessage.bind(this));
    this.authSocket.on('error', (err) => {
      log.error(`Error occurred on auth socket, restarting ...`, err.message);
      this.stopServer();
      this.startServer(wgConf).catch((err) => {
        log.error(`Failed to start assets controller server`, err.message);
      });
    });
    this.authSocket.bind(ASSETS_AUTH_PORT);
  }

  async processControlMessage(message, info) {
    message = message.toString();
    try {
      const msg = JSON.parse(message);
      switch (msg.type) {
        case MSG_PULL_CONFIG: {
          const uid = this.ipPublicKeyMap[info.address] && this.publicKeyUidMap[this.ipPublicKeyMap[info.address]];
          if (!uid) {
            log.error(`Cannot find uid of IP address ${info.address}, discard message ${msg.type}`, message);
            return;
          }
          this.schedulePushEffectiveConfig(uid);
          break;
        }
        case MSG_STATUS: {
          const uid = this.ipPublicKeyMap[info.address] && this.publicKeyUidMap[this.ipPublicKeyMap[info.address]];
          if (!uid) {
            log.error(`Cannot find uid of IP address ${info.address}, discard message ${msg.type}`);
            return;
          }
          await this.processStatusMsg(msg, uid);
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
    const deviceType = msg.deviceType || "ap";
    // write after read, need to acquire RWLock
    await ncm.acquireConfigRWLock(async () => {
      const networkConfig = await ncm.getActiveConfig();
      const template = defaultTemplateMap[deviceType];
      if (template && (!networkConfig.assets_template || !networkConfig.assets_template[template.key])) {
        networkConfig.assets_template = networkConfig.assets_template || {};
        networkConfig.assets_template[template.key] = template.value;
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
          Object.assign(networkConfig.assets[uid], {templateId: template.key});
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

  async processRawAuthMessage(message, info) {
    message = message.toString();
    try {
      const msg = JSON.parse(message);
      switch (msg.type) {
        case MSG_RAW_AUTH_REGISTER: {
          const publicKey = msg.publicKey;
          if (!publicKey) {
            log.error(`Public key is not found in raw auth message from ${info.address}`);
            return;
          }
          const uid = msg.uid;
          if (!uid) {
            log.error(`uid is not found in raw auth message from ${info.address}`);
            return;
          }
          await this.processAuthRegister(msg, publicKey);
          if (this.publicKeyIpMap[publicKey]) {
            log.info(`Public key ${publicKey} is already registered, send raw auth grant message to ${info.address}`);
            this.sendRawAuthGrant(uid, info.address, info.port);
          } else {
            log.info(`Public key ${publicKey} is not registered, awaiting wireguard peer adoption`);
            return;
          }
        }
      }
    } catch (err) {
      log.error(`Failed to handle assets authentication message from ${info.address}`, message, err.message);
    }
  }

  sendRawAuthGrant(uid, address, port) {
    if (!this.selfPublicKey || !this.uidPublicKeyMap[uid] || !this.publicKeyIpMap[this.uidPublicKeyMap[uid]] || !this.authSocket)
      return;
    const msg = JSON.stringify({type: MSG_RAW_AUTH_GRANT, uid: uid, publicKey: this.selfPublicKey, vip: this.publicKeyIpMap[this.uidPublicKeyMap[uid]], cip: this.selfIP});
    this.authSocket.send(msg, port, address);
  }

  sendSteerMessage(uid, staMAC, dstBSSID, dstChannel) {
    if (!this.controlSocket)
      return;
    const assetIP = this.uidPublicKeyMap[uid] && this.publicKeyIpMap[this.uidPublicKeyMap[uid]];
    if (!assetIP) {
      log.error(`Cannot find IP of asset ${uid}`);
      return;
    }
    const msg = JSON.stringify({type: MSG_BSS_STEER, staMac: staMAC, dstBSSID, dstChannel});
    this.controlSocket.send(msg, ASSETS_CONTROL_PORT, assetIP);
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

  async bssSteer(staMAC, targetAPUID, targetSSID = null, targetBand = null) {
    const staStatus = await this.getAPSTAStutus(staMAC);
    if (!staStatus)
      return;
    const currentAPUID = staStatus.assetUID;
    const currentBand = staStatus.band;
    if (!targetSSID)
      targetSSID = staStatus.ssid;
    if (!targetBand)
      targetBand = currentBand;
    const targetAPStatus = await this.getAPAssetsStatus(targetAPUID);
    const targetBSSes = targetAPStatus.aps[targetSSID];
    if (!_.isArray(targetBSSes) || _.isEmpty(targetBSSes)) {
      log.warn(`ssid ${targetSSID} is not found on target AP ${targetAPUID}`);
      return;
    }
    const targetBSS = targetBSSes.find(bss => bss.band === targetBand);
    if (!targetBSS) {
      log.warn(`ssid ${targetSSID} on band ${targetBand} is not found on target AP ${targetAPUID}`);
      return;
    }
    const targetBSSID = targetBSS.bssid;
    const targetChannel = targetBSS.channel;
    this.sendSteerMessage(currentAPUID, staMAC, targetBSSID, targetChannel);
  }
}

module.exports = new AssetsController();