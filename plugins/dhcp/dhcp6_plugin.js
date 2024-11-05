/*    Copyright 2020 Firewalla Inc
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

const pl = require('../plugin_loader.js');
const event = require('../../core/event.js');
const r = require('../../util/firerouter.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const DHCPPlugin = require('./dhcp_plugin.js');

const dhcpConfDir = r.getUserConfigFolder() + "/dhcp/conf";


class DHCP6Plugin extends DHCPPlugin {

  _getConfFilePath() {
    return `${dhcpConfDir}/${this.name}_v6.conf`;
  }

  async flush() {
    this.log.info("Flushing dhcp6", this.name);
    const confPath = this._getConfFilePath();
    await fs.unlinkAsync(confPath).catch((err) => {});
    this._restartService();
  }

  async writeDHCPConfFile(iface, tags, type = "stateless", from, to, nameservers, prefixLen, leaseTime = 86400) {
    tags = tags || [];
    nameservers = nameservers || [];
    let extraTags = "";
    type = type || "stateless";
    if (tags.length > 0) {
      extraTags = tags.map(tag => `tag:${tag}`).join(",") + ",";
    }
    const content = [];

    if (nameservers.length > 0){
      content.push(`dhcp-option=tag:${iface},option6:dns-server,${nameservers.map(a => `[${a}]`).join(",")}`);
    } else { // return router's link-local address as RDNSS option in ra
      content.push(`dhcp-option=tag:${iface},option6:dns-server,[::]`);
    }

    switch (type) {
      case "stateless": {
        // simply use slaac to configure client IPv6 address
        content.push(`dhcp-range=tag:${iface},${extraTags}::,constructor:${this.name},slaac,${leaseTime}`);
        content.push('enable-ra');
        content.push(`ra-param=${iface},15,3600`);
        break;
      }
      case "stateful": {
        if (!from || !to)
          this.fatal(`from/to is not specified for dhcp6 of ${this.name}`);
        if (prefixLen < 64)
          this.fatal(`prefixLen for dhcp6 of ${this.name} should be at least 64`);
        content.push(`dhcp-range=tag:${iface},${extraTags}${from},${to},${prefixLen},${leaseTime}`);
        content.push('enable-ra');
        content.push(`ra-param=${iface},15,3600`);
        break;
      }
      default:
    }
    await fs.writeFileAsync(this._getConfFilePath(), content.join("\n"));
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
    // in case prefix delegation is used, address may be changed dynamically
    this.subscribeChangeFrom(ifacePlugin);
    if (await ifacePlugin.isInterfacePresent() === false) {
      this.log.warn(`Interface ${this.name} is not present yet`);
      return;
    }
    await this.writeDHCPConfFile(iface, this.networkConfig.tags, this.networkConfig.type, this.networkConfig.range && this.networkConfig.range.from, this.networkConfig.range && this.networkConfig.range.to, this.networkConfig.nameservers,
      this.networkConfig.prefixLen, this.networkConfig.lease);
    this._restartService();
  }
}

module.exports = DHCP6Plugin;