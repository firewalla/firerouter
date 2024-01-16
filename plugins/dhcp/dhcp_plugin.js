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

const dhcpServiceFileTemplate = __dirname + "/firerouter_dhcp.template.service";
const dhcpScriptTemplate = __dirname + "/dhcp.template.sh";

const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const pl = require('../plugin_loader.js');
const _ = require('lodash');
const { Address4 } = require('ip-address');

const dhcpConfDir = r.getUserConfigFolder() + "/dhcp/conf";
const dhcpHostsDir = r.getUserConfigFolder() + "/dhcp/hosts2";
const dhcpRuntimeDir = r.getRuntimeFolder() + "/dhcp";

let _restartTask = null;

class DHCPPlugin extends Plugin {

  static async preparePlugin() {
    await this.createDirectories();
    await this.installSystemService();
    await this.installDHCPScript();
  }

  static async createDirectories() {
    await exec(`mkdir -p ${dhcpConfDir}`);
    await exec(`mkdir -p ${dhcpHostsDir}`);
    await exec(`mkdir -p ${dhcpRuntimeDir}`);
    await exec(`mkdir -p ${r.getTempFolder()}`)
  }

  static async installSystemService() {
    let content = await fs.readFileAsync(dhcpServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace("%WORKING_DIRECTORY%", r.getFireRouterHome());
    content = content.replace("%DHCP_DIRECTORY%", r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_dhcp.service";
    await fs.writeFileAsync(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);
  }

  static async installDHCPScript() {
    let content = await fs.readFileAsync(dhcpScriptTemplate, {encoding: 'utf8'});
    content = content.replace("%FIREROUTER_HOME%", r.getFireRouterHome());
    content = content.replace("%FIREROUTER_HOME%", r.getFireRouterHome());
    const targetFile = r.getTempFolder() + "/dhcp.sh";
    await fs.writeFileAsync(targetFile, content);
  }

  _getConfFilePath() {
    return `${dhcpConfDir}/${this.name}.conf`;
  }

  async flush() {
    this.log.info("Flushing dhcp", this.name);
    const confPath = this._getConfFilePath();
    await fs.unlinkAsync(confPath).catch((err) => {});
    this._restartService();
  }

  async writeDHCPConfFile(iface, tags, from, to, subnetMask, leaseTime, gateway, nameservers, searchDomains, extraOptions = {}) {
    tags = tags || [];
    nameservers = nameservers || [];
    searchDomains = searchDomains || [];
    let extraTags = "";
    if (tags.length > 0) {
      extraTags = tags.map(tag => `tag:${tag}`).join(",") + ",";
    }
    
    const dhcpRange = `dhcp-range=tag:${iface},${extraTags}${from},${to},${subnetMask},${leaseTime}`;
    const dhcpOptions = [];
    if (gateway)
      dhcpOptions.push(`dhcp-option=tag:${iface},${extraTags}3,${gateway}`);
    if (nameservers.length > 0)
      dhcpOptions.push(`dhcp-option=tag:${iface},${extraTags}6,${nameservers.join(",")}`);
    if (searchDomains.length > 0)
      dhcpOptions.push(`dhcp-option=tag:${iface},${extraTags}119,${searchDomains.join(",")}`);

    let useDhcpBoot = extraOptions.hasOwnProperty("66") && extraOptions.hasOwnProperty("67");
    if (useDhcpBoot) {
      dhcpOptions.push(`dhcp-boot=tag:${iface},${extraTags}${extraOptions["67"]},${new Address4(extraOptions["66"]).isValid() ? `,${extraOptions["66"]}` : extraOptions["66"]}`);
      dhcpOptions.push(`dhcp-option=tag:${iface},${extraTags}66,${extraOptions["66"]}`);
    }
    if (Object.keys(extraOptions).length > 0) {
      for (const key of Object.keys(extraOptions)) {
        const option = extraOptions[key];
        if ((key === "66" || key === "67") && useDhcpBoot)
          continue;
        // value can be either a literal string or an object.
        if (!_.isObject(option))
          dhcpOptions.push(`dhcp-option=tag:${iface},${extraTags}${key},${option}`);
        else // if it is an object, dhcp-option-force can be used if force is set to true
          dhcpOptions.push(`dhcp-option${option.force === true ? "-force" : ""}=tag:${iface},${extraTags}${key},${option.value}`);
      }
    }
    
    const content = `${dhcpRange}\n${dhcpOptions.join("\n")}`;
    await fs.writeFileAsync(this._getConfFilePath(), content);
  }

  _restartService() {
    if (!_restartTask) {
      _restartTask = setTimeout(() => {
        exec("sudo systemctl stop firerouter_dhcp; sudo systemctl start firerouter_dhcp").catch((err) => {
          this.log.warn("Failed to restart firerouter_dhcp", err.message);
        });
        _restartTask = null;
      }, 5000);
    }
  }

  async apply() {
    let iface = this.name;
    if (iface.includes(":")) {
      // virtual interface, need to strip suffix
      iface = this.name.substr(0, this.name.indexOf(":"));
    }
    const ifacePlugin = pl.getPluginInstance("interface", this.name);
    if (!ifacePlugin) {
      this.fatal(`Interface plugin ${this.name} is not found`);
    }
    this.subscribeChangeFrom(ifacePlugin);
    if (await ifacePlugin.isInterfacePresent() === false) {
      this.log.warn(`Interface ${this.name} is not present yet`);
      return;
    }
    await this.writeDHCPConfFile(iface, this.networkConfig.tags, this.networkConfig.range.from, this.networkConfig.range.to, this.networkConfig.subnetMask,
      this.networkConfig.lease, this.networkConfig.gateway, this.networkConfig.nameservers, this.networkConfig.searchDomain, this.networkConfig.extraOptions);
    this._restartService();
  }
}

module.exports = DHCPPlugin;