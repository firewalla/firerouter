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
const exec = require('child-process-promise').exec;
const pl = require('../plugin_loader.js');
const util = require('../../util/util.js');
const r = require('../../util/firerouter.js');
const event = require('../../core/event.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const serverKeyDir = `${r.getUserConfigFolder()}/sshd/keys`;
const keyAlgorithms = ['dsa', 'ecdsa', 'ed25519', 'rsa'];


class SSHDPlugin extends Plugin {

  static getKeyFilePath(alg) {
    return `${serverKeyDir}/ssh_host_${alg}_key`;
  }

  static async preparePlugin() {
    await exec(`mkdir -p ${r.getUserConfigFolder()}/sshd`);
    await SSHDPlugin.ensureGenerateHostKeys();
  }

  static async ensureGenerateHostKeys() {
    await exec(`mkdir -p ${serverKeyDir}`);
    for (const alg of keyAlgorithms) {
      const keyFilePath = SSHDPlugin.getKeyFilePath(alg);
      await fs.accessAsync(keyFilePath, fs.constants.F_OK).then(() => {
        return exec(`bash -c 'diff <( ssh-keygen -y -e -f ${keyFilePath} ) <( ssh-keygen -y -e -f ${keyFilePath}.pub )'`);  
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
    await fs.unlinkAsync(confPath).catch((err) => {});
    await this.reloadSSHD().catch((err) => {});
  }

  async reloadSSHD() {
    await exec(`${__dirname}/reload_sshd.sh`).catch((err) => {
      this.log.error(`Failed to execute reload_sshd.sh`, err.message);
    });
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
      if (state && state.ip4) {
        const ipv4Addr = state.ip4.split("/")[0];
        await fs.writeFileAsync(confPath, `ListenAddress ${ipv4Addr}`, {encoding: 'utf8'});
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
      await this.reloadSSHD();
    } else {
      const confPath = this._getConfFilePath();
      await fs.unlinkAsync(confPath).catch((err) => {});
      await exec(util.wrapIptables(`sudo iptables -w -D FR_SSH -i ${this.name} -p tcp --dport 22 -j ACCEPT`)).catch((err) => {});
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