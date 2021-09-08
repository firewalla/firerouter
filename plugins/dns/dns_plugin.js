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

const Plugin = require('../plugin.js');
const pl = require('../plugin_loader.js');
const event = require('../../core/event.js');

const dnsServiceFileTemplate = __dirname + "/firerouter_dns.template.service";
const dnsScriptTemplate = __dirname + "/dns.template.sh";

const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

let _restartTask = null;

const dnsConfTemplate = r.getFireRouterHome() + "/etc/dnsmasq.dns.conf.template";

class DNSPlugin extends Plugin {

  static async preparePlugin() {
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/13-dnsmasq.conf /etc/rsyslog.d/`);
    await this.createDirectories();
    await this.installDNSScript();
    await this.installSystemService();
  }

  static async createDirectories() {
    await exec(`mkdir -p ${r.getUserConfigFolder()}/dnsmasq`).catch((err) => {});
    await exec(`mkdir -p ${r.getRuntimeFolder()}/dnsmasq`).catch((err) => {});
    await exec(`mkdir -p ${r.getTempFolder()}`).catch((err) => {});
    await exec(`mkdir -p ${r.getFirewallaUserConfigFolder()}/dnsmasq_local`).catch((err) => {});
  } 

  static async installSystemService() {
    let content = await fs.readFileAsync(dnsServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace(/%WORKING_DIRECTORY%/g, r.getFireRouterHome());
    content = content.replace(/%DNS_DIRECTORY%/g, r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_dns.service";
    await fs.writeFileAsync(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);
    await exec("sudo systemctl daemon-reload");
  }

  static async installDNSScript() {
    let content = await fs.readFileAsync(dnsScriptTemplate, {encoding: 'utf8'});
    content = content.replace(/%FIREROUTER_HOME%/g, r.getFireRouterHome());
    const targetFile = r.getTempFolder() + "/dns.sh";
    await fs.writeFileAsync(targetFile, content);
  }

  async flush() {
    const confPath = this._getConfFilePath();
    await fs.unlinkAsync(confPath).catch((err) => {});
    await fs.unlinkAsync(this._getResolvFilePath()).catch((err) => {});
    // do not touch firewalla user config dnsmasq directory in flush()
    this._restartService();
  }

  _getConfFilePath() {
    return `${r.getFireRouterHome()}/etc/dnsmasq.dns.${this.name}.conf`;
  }

  _getResolvFilePath() {
    return `${r.getUserConfigFolder()}/dnsmasq/${this.name}.resolv.conf`;
  }

  async prepareEnvironment() {
    await exec(`mkdir -p ${r.getFirewallaUserConfigFolder()}/dnsmasq/${this._intfUuid}`).catch((err) => {});
  }

  async writeDNSConfFile() {
    let content = await fs.readFileAsync(dnsConfTemplate, {encoding: "utf8"});
    content = content.replace(/%INTERFACE%/g, this.name);
    content = content.replace(/%INTERFACE_UUID%/g, this._intfUuid);
    await fs.writeFileAsync(this._getConfFilePath(), content);

    await fs.unlinkAsync(this._getResolvFilePath()).catch((err) => {});
    if (this.networkConfig.nameservers) {
      const nameservers = this.networkConfig.nameservers.map((n) => `nameserver ${n}`).join("\n");
      await fs.writeFileAsync(this._getResolvFilePath(), nameservers);
    } else {
      if (this.networkConfig.useNameserversFromWAN) {
        const routingPlugin = pl.getPluginInstance("routing", this.name) || pl.getPluginInstance("routing", "global");
        if (routingPlugin) {
          this.subscribeChangeFrom(routingPlugin);
          const wanIntfPlugins = routingPlugin.getActiveWANPlugins();
          if (wanIntfPlugins.length > 0) {
            const wanIntf = wanIntfPlugins[0].name;
            await fs.symlinkAsync(r.getInterfaceResolvConfPath(wanIntf), this._getResolvFilePath());
          } else {
            // use primary WAN's name server as tentative upstream DNS nameserver if no active WAN is available
            let intfPlugin = routingPlugin.getPrimaryWANPlugin();
            const allWanIntfPlugins = routingPlugin.getAllWANPlugins() || [];
            for (const wanIntfPlugin of allWanIntfPlugins) {
              // fs.existsSync will return false if the (recursive) symlink points to a non-existing file
              if (fs.existsSync(r.getInterfaceResolvConfPath(wanIntfPlugin.name))) {
                intfPlugin = wanIntfPlugin;
                break;
              }
            }
            if (intfPlugin) {
              this.log.error(`No active WAN is for for dns ${this.name}, tentatively choosing the primary WAN ${intfPlugin.name}`);
              await fs.symlinkAsync(r.getInterfaceResolvConfPath(intfPlugin.name), this._getResolvFilePath());
            } else {
              this.log.error(`No active WAN is for for dns ${this.name}, DNS is temporarily unavailable`);
            }
          }
        } else {
          this.fatal(`Cannot find routing plugin for ${this.name}`);
        }
      }
    }
  }

  async applyDefaultResolvConf() {
    await fs.unlinkAsync(this._getResolvFilePath()).catch((err) => {});
    if (this.networkConfig.nameservers) {
      const nameservers = this.networkConfig.nameservers.map((n) => `nameserver ${n}`).join("\n");
      await fs.writeFileAsync(this._getResolvFilePath(), nameservers);
    } else {
      if (this.networkConfig.useNameserversFromWAN) {
        const routingPlugin = pl.getPluginInstance("routing", "global");
        if (routingPlugin) {
          this.subscribeChangeFrom(routingPlugin);
          const wanIntfPlugins = routingPlugin.getActiveWANPlugins();
          if (wanIntfPlugins.length > 0) {
            const wanIntf = wanIntfPlugins[0].name;
            await fs.symlinkAsync(r.getInterfaceResolvConfPath(wanIntf), this._getResolvFilePath());
          } else {
            // use primary WAN's name server as tentative upstream DNS nameserver if no active WAN is available
            let intfPlugin = routingPlugin.getPrimaryWANPlugin();
            const allWanIntfPlugins = routingPlugin.getAllWANPlugins() || [];
            for (const wanIntfPlugin of allWanIntfPlugins) {
              // fs.existsSync will return false if the (recursive) symlink points to a non-existing file
              if (fs.existsSync(r.getInterfaceResolvConfPath(wanIntfPlugin.name))) {
                intfPlugin = wanIntfPlugin;
                break;
              }
            }
            if (intfPlugin) {
              this.log.error(`No active WAN is for for dns ${this.name}, tentatively choosing the WAN ${intfPlugin.name}`);
              await fs.symlinkAsync(r.getInterfaceResolvConfPath(intfPlugin.name), this._getResolvFilePath());
            } else {
              this.log.error(`No active WAN is for for dns ${this.name}, DNS is temporarily unavailable`);
            }
          }
        } else {
          this.fatal(`Cannot find routing plugin for ${this.name}`);
        }
      }
    }
    await exec(`sudo rm -f /etc/resolv.conf`);
    await exec(`sudo ln -s ${this._getResolvFilePath()} /etc/resolv.conf`);
  }

  _restartService() {
    if (!_restartTask) {
      _restartTask = setTimeout(() => {
        exec("sudo systemctl stop firerouter_dns; sudo systemctl start firerouter_dns").catch((err) => {
          this.log.warn("Failed to restart firerouter_dns", err.message);
        });
        _restartTask = null;
      }, 5000);
    }
  }

  async apply() {
    const confPath = this._getConfFilePath();
    await fs.unlinkAsync(confPath).catch((err) => {});
    await fs.unlinkAsync(this._getResolvFilePath()).catch((err) => {});
    if (this.name !== "default") {
      const intfPlugin = pl.getPluginInstance("interface", this.name);
      if (!intfPlugin)
        this.fatal(`Cannot find interface plugin for ${this.name}`);
      this._intfUuid = intfPlugin.networkConfig && intfPlugin.networkConfig.meta && intfPlugin.networkConfig.meta.uuid;
      if (!this._intfUuid)
        this.fatal(`Cannot find interface uuid for ${this.name}`);
      this.subscribeChangeFrom(intfPlugin);
      if (await intfPlugin.isInterfacePresent() === false) {
        this.log.warn(`Interface ${this.name} is not present yet`);
        return;
      }
      if (!intfPlugin.networkConfig.enabled) {
        this.log.warn(`Interface ${this.name} is not enabled`);
        return;
      }
      const state = await intfPlugin.state();
      if (!state || !state.ip4) {
        this.log.warn(`Interface ${this.name} does not have IPv4 address`);
        return;
      }
      await this.prepareEnvironment();
      await this.writeDNSConfFile();
      this._restartService();
    } else {
      await this.applyDefaultResolvConf();
    }
  }

  onEvent(e) {
    if (!event.isLoggingSuppressed(e))
      this.log.info(`Received event on ${this.name}`, e);
    const eventType = event.getEventType(e);
    switch (eventType) {
      case event.EVENT_WAN_SWITCHED:
      case event.EVENT_IP_CHANGE: {
        this._reapplyNeeded = true;
        pl.scheduleReapply();
        break;
      }
      default:
    }
  }
}

module.exports = DNSPlugin;