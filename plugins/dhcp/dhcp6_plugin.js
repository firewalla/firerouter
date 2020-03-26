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

const Plugin = require('../plugin.js');

const exec = require('child-process-promise').exec;
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

  async writeDHCPConfFile(iface, tags, type = "stateless", from, to, prefixLen, leaseTime = 86400) {
    tags = tags || [];
    let extraTags = "";
    type = type || "stateless";
    if (tags.length > 0) {
      extraTags = tags.map(tag => `tag:${tag}`).join(",") + ",";
    }
    const content = [];
    switch (type) {
      case "stateless": {
        // simply use slaac to configure client IPv6 address
        content.push(`dhcp-range=tag:${iface},${extraTags}::,constructor:${this.name},slaac,${leaseTime}`);
        content.push('enable-ra');
        break;
      }
      case "stateful": {
        if (!from || !to)
          this.fatal(`from/to is not specified for dhcp6 of ${this.name}`);
        if (prefixLen < 64)
          this.fatal(`prefixLen for dhcp6 of ${this.name} should be at least 64`);
        content.push(`dhcp-range=tag:${iface},${extraTags}${from},${to},${prefixLen},${leaseTime}`);
        content.push('enable-ra');
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
    await this.writeDHCPConfFile(iface, this.networkConfig.tags, this.networkConfig.type, this.networkConfig.range && this.networkConfig.range.from, this.networkConfig.range && this.networkConfig.range.to, 
      this.networkConfig.prefixLen, this.networkConfig.lease);
    this._restartService();
  }
}

module.exports = DHCP6Plugin;