/*    Copyright 2019 - 2020 Firewalla Inc
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
const { exec, execFile } = require('child-process-promise');
const pl = require('../plugin_loader.js');
const util = require('../../util/util.js');
const r = require('../../util/firerouter.js');
const event = require('../../core/event.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const platform = require('../../platform/PlatformLoader.js').getPlatform();
const AsyncLock = require('async-lock');
const lock = new AsyncLock();

const serverKeyDir = `${r.getUserConfigFolder()}/sshd/keys`;
const keyAlgorithms = platform.getSSHKeyTypes();
const sshdConfigDir = `${r.getUserConfigFolder()}/sshd`;
const extraConfigDir = `${r.getUserConfigFolder()}/sshd_config.d`;
const listenAddressesPath = `${sshdConfigDir}/listen_addresses`;
const listenStatePath = `${sshdConfigDir}/listen_state.json`;
const LOCK_RELOAD = "LOCK_RELOAD_SSHD";
// sshd plugins apply concurrently, one reload after all of them instead of one per interface
const RELOAD_DELAY = 3000;
// OpenSSH's MAX_LISTEN_SOCKS: with one listen address more, sshd exits on start or reload and ssh
// stops working on every network, loopback included
const MAX_LISTEN_SOCKS = 16;
const LOOPBACK_LISTEN_ADDRESSES = 1; // ListenAddress 127.0.0.1 in default_sshd_config


class SSHDPlugin extends Plugin {

  static getKeyFilePath(alg) {
    return `${serverKeyDir}/ssh_host_${alg}_key`;
  }

  static async preparePlugin() {
    await execFile("mkdir", ["-p", `${r.getUserConfigFolder()}/sshd`]);
    await SSHDPlugin.ensureGenerateHostKeys();
  }

  static async ensureGenerateHostKeys() {
    await execFile("mkdir", ["-p", serverKeyDir]);
    for (const alg of keyAlgorithms) {
      const keyFilePath = SSHDPlugin.getKeyFilePath(alg);
      await fs.accessAsync(keyFilePath, fs.constants.F_OK).then(() => {
        // public key file not empty and matches private key
        return exec(`sudo bash -c '[ -s "${keyFilePath}.pub" ] && diff <(cut -d" " -f 2 ${keyFilePath}.pub) <(ssh-keygen -y -f ${keyFilePath} | cut -d" " -f 2)'`);  
      }).catch((err) => {
        console.log(`Key verification on ${keyFilePath} failed`, err.message);
        return exec(`sudo bash -c 'ssh-keygen -f ${keyFilePath} -N "" -q -t ${alg} <<< y' 2>&1 > /dev/null`).catch((err) => {
          // todo
          console.log(`Generate host key ${keyFilePath} failed.`, err.message);
        });
      });
    }
  }

  async flush() {
    this.log.info("Flushing SSHD", this.name);
    const confPath = this._getConfFilePath();
    await exec(util.wrapIptables(`sudo iptables -w -D FR_SSH -i ${this.name} -p tcp --dport 22 -j ACCEPT`)).catch((err) => {});
    await exec(util.wrapIptables(`sudo iptables -w -D FR_SSH -i ${this.name} -p tcp --dport 22 -j DROP`)).catch((err) => {});
    await fs.unlinkAsync(confPath).catch((err) => {});
    await this.reloadSSHD().catch((err) => {});
  }

  async reloadSSHD() {
    SSHDPlugin.scheduleReload(this.log);
  }

  // written to a temp file and renamed, so the listen_state route never reads a half-written file
  static async _writeFileAtomic(path, content) {
    const tmpPath = `${path}.tmp`;
    await fs.writeFileAsync(tmpPath, content);
    await fs.renameAsync(tmpPath, path);
  }

  static scheduleReload(log) {
    if (SSHDPlugin._reloadTask)
      clearTimeout(SSHDPlugin._reloadTask);
    SSHDPlugin._reloadTask = setTimeout(() => {
      SSHDPlugin._reloadTask = null;
      lock.acquire(LOCK_RELOAD, async () => {
        await SSHDPlugin.writeListenAddresses(log);
        await execFile(`${__dirname}/reload_sshd.sh`, []);
      }).catch((err) => {
        log.error(`Failed to reload sshd`, err.message);
      });
    }, RELOAD_DELAY);
  }

  // LAN first, then interfaces that are neither, WAN last; by name within each, numbers in order.
  // the app sends the whole config on every change, so this order does not depend on history
  static selectListenAddresses(entries, budget) {
    const sorted = entries.slice().sort((a, b) => a.rank - b.rank || a.intf.localeCompare(b.intf, undefined, { numeric: true }));
    const listening = [];
    const dropped = [];
    const seen = new Set();
    for (const { intf, ip } of sorted) {
      if (seen.has(ip))
        continue;
      seen.add(ip);
      (listening.length < budget ? listening : dropped).push({ intf, ip });
    }
    return { listening, dropped };
  }

  static _listenRank(intf) {
    const intfPlugin = pl.getPluginInstance("interface", intf);
    if (intfPlugin && intfPlugin.isLAN())
      return 0;
    if (intfPlugin && intfPlugin.isWAN())
      return 2;
    return 1;
  }

  static async _countExtraListenAddresses() {
    const files = await fs.readdirAsync(extraConfigDir).catch(() => []);
    let count = 0;
    for (const file of files.filter(f => f.endsWith(".conf"))) {
      const content = await fs.readFileAsync(`${extraConfigDir}/${file}`, "utf8").catch(() => "");
      count += (content.match(/^\s*ListenAddress\s/gim) || []).length;
    }
    return count;
  }

  // writes the ListenAddress lines reload_sshd.sh puts in sshd_config, capped so sshd can still start
  static async writeListenAddresses(log) {
    const files = await fs.readdirAsync(sshdConfigDir).catch(() => []);
    const entries = [];
    for (const file of files) {
      const m = file.match(/^sshd_config\.(.+)$/);
      if (!m)
        continue;
      const intf = m[1];
      const rank = SSHDPlugin._listenRank(intf);
      const content = await fs.readFileAsync(`${sshdConfigDir}/${file}`, "utf8").catch(() => "");
      for (const line of content.split(/\\n|\n/)) {
        const ip = line.replace(/^\s*ListenAddress\s+/, "").trim();
        if (ip)
          entries.push({ intf, ip, rank });
      }
    }
    const budget = Math.max(0, MAX_LISTEN_SOCKS - LOOPBACK_LISTEN_ADDRESSES - await SSHDPlugin._countExtraListenAddresses());
    const { listening, dropped } = SSHDPlugin.selectListenAddresses(entries, budget);
    if (dropped.length > 0)
      log.warn(`sshd listens on at most ${budget} network addresses, not listening on ${dropped.map(e => `${e.ip} (${e.intf})`).join(", ")}`);
    // escaped \\n on purpose, reload_sshd.sh passes it to sed
    await fs.writeFileAsync(listenAddressesPath, listening.map(e => `ListenAddress ${e.ip}`).join('\\n'));
    await SSHDPlugin._writeFileAtomic(listenStatePath, JSON.stringify({ listening, dropped }));
  }

  static async getListenState() {
    const content = await fs.readFileAsync(listenStatePath, "utf8").catch(() => null);
    return content ? JSON.parse(content) : { listening: [], dropped: [] };
  }

  _getConfFilePath() {
    return `${r.getUserConfigFolder()}/sshd/sshd_config.${this.name}`;
  }

  async generateConfFile() {
    const confPath = this._getConfFilePath();
    const iface = this.name;
    const ifacePlugin = pl.getPluginInstance("interface", iface);
    if (ifacePlugin) {
      this.subscribeChangeFrom(ifacePlugin);
      const state = await ifacePlugin.state();
      if (state && state.ip4s) {
        const entries = state.ip4s.map(ip => `ListenAddress ${ip.split("/")[0]}`);
        await fs.writeFileAsync(confPath, entries.join('\\n')); // use escaped \\ on purpose, the reload_ssh.sh script will handle it properly
      } else {
        this.log.error("Failed to get ip4 of interface " + iface);
      }
    } else {
      this.log.error("Cannot find interface plugin " + iface);
    }
  }

  async apply() {
    if (this.networkConfig.enabled) {
      await this.generateConfFile();
      await exec(util.wrapIptables(`sudo iptables -w -A FR_SSH -i ${this.name} -p tcp --dport 22 -j ACCEPT`)).catch((err) => {});
      await exec(util.wrapIptables(`sudo iptables -w -D FR_SSH -i ${this.name} -p tcp --dport 22 -j DROP`)).catch((err) => {});
      await this.reloadSSHD();
    } else {
      const confPath = this._getConfFilePath();
      await fs.unlinkAsync(confPath).catch((err) => {});
      await exec(util.wrapIptables(`sudo iptables -w -D FR_SSH -i ${this.name} -p tcp --dport 22 -j ACCEPT`)).catch((err) => {});
      await exec(util.wrapIptables(`sudo iptables -w -A FR_SSH -i ${this.name} -p tcp --dport 22 -j DROP`)).catch((err) => {});
      await this.reloadSSHD();
    }
  }

  onEvent(e) {
    if (!event.isLoggingSuppressed(e))
      this.log.info(`Received event on ${this.name}`, e);
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

module.exports = SSHDPlugin;