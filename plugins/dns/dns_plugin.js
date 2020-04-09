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
    await this.createDirectories();
    await this.installDNSScript();
    await this.installSystemService();
  }

  static async createDirectories() {
    await exec(`mkdir -p ${r.getUserConfigFolder()}/dnsmasq`).catch((err) => {});
    await exec(`mkdir -p ${r.getRuntimeFolder()}/dnsmasq`).catch((err) => {});
    await exec(`mkdir -p ${r.getTempFolder()}`).catch((err) => {});
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
    content = content.replace(/%DNSMASQ_BINARY%/g, r.getFireRouterHome() + "/bin/dnsmasq");
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
          const defaultRoute = routingPlugin.networkConfig.default;
          if (!defaultRoute)
            this.fatal(`Default route is not set in ${routingPlugin.name}`);
          const type = defaultRoute.type || "single";
          switch (type) {
            case "single": {
              const wanIntf = defaultRoute.viaIntf;
              if (wanIntf) {
                await fs.symlinkAsync(r.getInterfaceResolvConfPath(wanIntf), this._getResolvFilePath());
              } else {
                this.fatal(`Cannot find WAN interface for ${this.name}`);
              }
              break;
            }
            case "primary_standby": {
              const primaryIntf = defaultRoute.viaIntf;
              let primaryNameservers = [];
              const standbyIntf = defaultRoute.viaIntf2;
              let standbyNameservers = [];
              if (primaryIntf && standyIntf) {
                primaryNameservers = await fs.readFileAsync(r.getInterfaceResolvConfPath(primaryIntf), {encoding: "utf8"}).then((content) => content.split("\n").filter(l => l.length > 0)).catch((err) => {
                  this.log.error(`Failed to get nameservers for ${primaryIntf}`, err);
                  return [];
                });
              } else {
                this.log.error(`Cannot find primary WAN interface for ${this.name}`);
              }
              if (standyIntf) {
                standbyNameservers = await fs.readFileAsync(r.getInterfaceResolvConfPath(standbyIntf), {encoding: "utf8"}).then((content) => content.split("\n").filter(l => l.length > 0)).catch((err) => {
                  this.log.error(`Failed to get nameservers for ${standbyIntf}`, err);
                  return [];
                });
              } else {
                this.log.error(`Cannot find standby WAN interface for ${this.name}`);
              }
              await fs.writeFileAsync(this._getResolvFilePath(), primaryNameservers.concat(standbyNameservers).join("\n"));
              break;
            }
            case "load_balance": {
              const nextHops = defaultRoute.nextHops;
              let nameservers = [];
              for (let nextHop of nextHops) {
                const wanIntf = nextHop.viaIntf;
                if (wanIntf) {
                  const intfNameservers = await fs.readFileAsync(r.getInterfaceResolvConfPath(wanIntf), {encoding: "utf8"}).then((content) => content.split("\n").filter(l => l.length > 0)).catch((err) => {
                    this.log.error(`Failed to get nameservers for ${wanIntf}`, err);
                    return [];
                  });
                  nameservers = nameservers.concat(intfNameservers);
                } else {
                  this.log.error(`Cannot find WAN interface for ${this.name}`);
                }
              }
              await fs.writeFileAsync(this._getResolvFilePath(), nameservers.join("\n"));
              break;
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
          const wanIntf = routingPlugin.networkConfig && routingPlugin.networkConfig.default && routingPlugin.networkConfig.default.viaIntf;
          if (wanIntf) {
            await fs.symlinkAsync(r.getInterfaceResolvConfPath(wanIntf), this._getResolvFilePath());
          } else {
            this.fatal(`Cannot find WAN interface for ${this.name}`);
            return;
          }
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
    if (this.name !== "default") {
      const intfPlugin = pl.getPluginInstance("interface", this.name);
      if (!intfPlugin)
        this.fatal(`Cannot find interface plugin for ${this.name}`);
      this._intfUuid = intfPlugin.networkConfig && intfPlugin.networkConfig.meta && intfPlugin.networkConfig.meta.uuid;
      if (!this._intfUuid)
        this.fatal(`Cannot find interface uuid for ${this.name}`);
      this.subscribeChangeFrom(intfPlugin);
      await this.prepareEnvironment();
      await this.writeDNSConfFile();
      this._restartService();
    } else {
      await this.applyDefaultResolvConf();
    }
  }

  onEvent(e) {
    this.log.info("Received event", e);
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

module.exports = DNSPlugin;