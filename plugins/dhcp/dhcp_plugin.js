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

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');

const dhcpServiceFileTemplate = __dirname + "/firerouter_dhcp.template.service";
const dhcpScriptTemplate = __dirname + "/dhcp.template.sh";

const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const dhcpConfDir = r.getUserConfigFolder() + "/dhcp/conf";
const dhcpHostsDir = r.getUserConfigFolder() + "/dhcp/hosts";
const dhcpRuntimeDir = r.getRuntimeFolder() + "/dhcp";

class DHCPPlugin extends Plugin {

  _getConfFilePath() {
    return `${dhcpConfDir}/${this.name}.conf`;
  }

  async flush() {
    log.info("Flushing dhcp", this.name);
    const confPath = this._getConfFilePath();
    await fs.unlinkAsync(confPath).catch((err) => {});
    await exec("sudo systemctl restart firerouter_dhcp");
  }

  async prepareEnvironment() {
    await exec(`mkdir -p ${dhcpConfDir}`);
    await exec(`mkdir -p ${dhcpHostsDir}`);
    await exec(`mkdir -p ${dhcpRuntimeDir}`);
  }

  async installSystemService() {
    let content = await fs.readFileAsync(dhcpServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace("%WORKING_DIRECTORY%", r.getFireRouterHome());
    content = content.replace("%DHCP_DIRECTORY%", r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_dhcp.service";
    await fs.writeFileAsync(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);
    await exec("sudo systemctl daemon-reload");
  }

  async installDHCPScript() {
    let content = await fs.readFileAsync(dhcpScriptTemplate, {encoding: 'utf8'});
    content = content.replace("%FIREROUTER_HOME%", r.getFireRouterHome());
    content = content.replace("%FIREROUTER_HOME%", r.getFireRouterHome());
    const targetFile = r.getTempFolder() + "/dhcp.sh";
    await fs.writeFileAsync(targetFile, content);
  }

  async writeDHCPConfFile(iface, tags, from, to, subnetMask, leaseTime, gateway, nameservers, searchDomains) {
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
    
    const content = `${dhcpRange}\n${dhcpOptions.join("\n")}`;
    await fs.writeFileAsync(this._getConfFilePath(), content);
  }

  async apply() {
    await this.prepareEnvironment();
    await this.installDHCPScript();
    await this.installSystemService();
    let iface = this.name;
    if (iface.includes(":")) {
      // virtual interface, need to strip suffix
      iface = this.name.substr(0, this.name.indexOf(":"));
    }
    await this.writeDHCPConfFile(iface, this.networkConfig.tags, this.networkConfig.range.from, this.networkConfig.range.to, this.networkConfig.subnetMask,
      this.networkConfig.lease, this.networkConfig.gateway, this.networkConfig.nameservers, this.networkConfig.searchDomain);
    await exec("sudo systemctl restart firerouter_dhcp");
  }
}

module.exports = DHCPPlugin;