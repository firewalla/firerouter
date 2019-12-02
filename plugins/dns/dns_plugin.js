'use strict';

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');
const pl = require('../plugin_loader.js');

const dnsServiceFileTemplate = __dirname + "/firerouter_dns.template.service";
const dnsScriptTemplate = __dirname + "/dns.template.sh";

const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const dnsConfTemplate = r.getFireRouterHome() + "/etc/dnsmasq.dns.conf.template";

class DNSPlugin extends Plugin {

  async flush() {
    log.info("Flushing dns", this.name);
    const confPath = this._getConfFilePath();
    await fs.unlinkAsync(confPath).catch((err) => {});
    await exec("sudo systemctl restart firerouter_dns");
  }

  _getConfFilePath() {
    return `${r.getFireRouterHome()}/etc/dnsmasq.dns.${this.name}.conf`;
  }

  _getResolvFilePath() {
    return `${r.getUserConfigFolder()}/dnsmasq/${this.name}.resolv.conf`;
  }

  async prepareEnvironment() {
    await exec(`mkdir -p ${r.getFirewallaUserConfigFolder()}/dnsmasq/${this.name}`).catch((err) => {});
    await exec(`mkdir -p ${r.getUserConfigFolder()}/dnsmasq`).catch((err) => {});
    await exec(`mkdir -p ${r.getRuntimeFolder()}/dnsmasq`).catch((err) => {});
  }

  async installSystemService() {
    let content = await fs.readFileAsync(dnsServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace("%WORKING_DIRECTORY%", r.getFireRouterHome());
    content = content.replace("%DNS_DIRECTORY%", r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_dns.service";
    await fs.writeFileAsync(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);
    await exec("sudo systemctl daemon-reload");
  }

  async installDNSScript() {
    let content = await fs.readFileAsync(dnsScriptTemplate, {encoding: 'utf8'});
    content = content.replace("%FIREROUTER_HOME%", r.getFireRouterHome());
    content = content.replace("%DNSMASQ_BINARY%", r.getFireRouterHome() + "/bin/dnsmasq");    
    const targetFile = r.getTempFolder() + "/dns.sh";
    await fs.writeFileAsync(targetFile, content);
  }

  async writeDNSConfFile() {
    let content = await fs.readFileAsync(dnsConfTemplate, {encoding: "utf8"});
    content = content.replace(/%INTERFACE%/g, this.name);
    await fs.writeFileAsync(this._getConfFilePath(), content);

    await fs.unlinkAsync(this._getResolvFilePath()).catch((err) => {});
    if (this.networkConfig.nameservers) {
      const nameservers = this.networkConfig.nameservers.map((n) => `nameserver ${n}`).join("\n");
      await fs.writeFileAsync(this._getResolvFilePath(), nameservers);
    } else {
      if (this.networkConfig.useNameserversFromWAN) {
        const routingPlugin = pl.getPluginInstance("routing", this.name) || pl.getPluginInstance("routing", "global");
        if (routingPlugin) {
          const wanIntf = routingPlugin.networkConfig && routingPlugin.networkConfig.default && routingPlugin.networkConfig.default.viaIntf;
          if (wanIntf) {
            await fs.symlinkAsync(r.getInterfaceResolvConfPath(wanIntf), this._getResolvFilePath());
          } else {
            log.error(`Cannot find WAN interface for ${this.name}`);
          }
        } else {
          log.error(`Cannot find routing plugin for ${this.name}`);
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
          const wanIntf = routingPlugin.networkConfig && routingPlugin.networkConfig.default && routingPlugin.networkConfig.default.viaIntf;
          if (wanIntf) {
            await fs.symlinkAsync(r.getInterfaceResolvConfPath(wanIntf), this._getResolvFilePath());
          } else {
            log.error(`Cannot find WAN interface for ${this.name}`);
            return;
          }
        }
      }
    }
    await exec(`sudo rm -f /etc/resolv.conf`);
    await exec(`sudo ln -s ${this._getResolvFilePath()} /etc/resolv.conf`);
  }

  async apply() {
    if (this.name !== "default") {
      await this.prepareEnvironment();
      await this.installDNSScript();
      await this.installSystemService();
      await this.writeDNSConfFile();
      await exec("sudo systemctl restart firerouter_dns");
    } else {
      await this.applyDefaultResolvConf();
    }
  }
}

module.exports = DNSPlugin;