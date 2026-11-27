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

const r = require('../../util/firerouter.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const DHCPPlugin = require('./dhcp_plugin.js');

const dhcpConfDir = r.getUserConfigFolder() + "/dhcp/conf";

const MIN_LEASE_TIME = 129;
const DEPRECATED_PREFIX_RA_LEASE = "120s";


class DHCP6Plugin extends DHCPPlugin {

  _getConfFilePath() {
    return `${dhcpConfDir}/${this.name}_v6.conf`;
  }

  async writeDHCPConfFile(iface, tags, type = "stateless", from, to, nameservers, prefixLen, leaseTime = 86400, raInterval = 200, raLifetime, deprecatedPrefixes = []) {
    tags = tags || [];
    nameservers = nameservers || [];
    let extraTags = "";
    type = type || "stateless";
    if (tags.length > 0) {
      extraTags = tags.map(tag => `tag:${tag}`).join(",") + ",";
    }

    if (leaseTime < MIN_LEASE_TIME) {
      this.log.warn(`leaseTime ${leaseTime} for dhcp6 of ${this.name} is too small and would confuse dnsmasq's dhcp-range parser, adjusted to ${MIN_LEASE_TIME}`);
      leaseTime = MIN_LEASE_TIME;
    }

    if (raLifetime === undefined) {
      raLifetime = Math.max(3600, raInterval);
    }

    if (!Number.isInteger(raLifetime) || raLifetime < 0 || raLifetime > 65535 || (raLifetime !== 0 && raLifetime < raInterval)) {
      this.fatal(`raLifetime for dhcp6 of ${this.name} should be 0 or an integer between raInterval and 65535`);
    }

    const content = [];

    if (nameservers.length > 0){
      content.push(`dhcp-option=tag:${iface},option6:dns-server,${nameservers.map(a => `[${a}]`).join(",")}`);
    } else { // return global address as RDNSS option in ra
      content.push(`dhcp-option=tag:${iface},option6:dns-server,[::]`);
    }

    switch (type) {
      case "stateless": {
        // simply use slaac to configure client IPv6 address
        content.push(`dhcp-range=tag:${iface},${extraTags}::,constructor:${this.name},slaac,${leaseTime}`);
        content.push('enable-ra');
        content.push(`ra-param=${iface},${raInterval},${raLifetime}`);
        break;
      }
      case "stateful": {
        if (!from || !to)
          this.fatal(`from/to is not specified for dhcp6 of ${this.name}`);
        if (!(prefixLen >= 64))
          this.fatal(`prefixLen for dhcp6 of ${this.name} should be at least 64`);
        content.push(`dhcp-range=tag:${iface},${extraTags}${from},${to},${prefixLen},${leaseTime}`);
        content.push('enable-ra');
        content.push(`ra-param=${iface},${raInterval},${raLifetime}`);
        break;
      }
      default:
    }

    // A prefix upstream has renumbered away from (see _deprecateObsoleteIPv6Prefixes) needs an
    // explicit range, since dnsmasq builds none for a deprecated address. Two ranges per prefix:
    // one with the lease time (bounds valid lifetime), one "deprecated" (zeroes preferred lifetime).
    if (type === "stateless" || type === "stateful") {
      for (const {prefix} of deprecatedPrefixes) {
        const prefixAddr = prefix.split("/")[0];
        content.push(`dhcp-range=tag:${iface},${extraTags}${prefixAddr},ra-only,${DEPRECATED_PREFIX_RA_LEASE}`);
        content.push(`dhcp-range=tag:${iface},${extraTags}${prefixAddr},ra-only,deprecated`);
      }
    }

    await fs.writeFileAsync(this._getConfFilePath(), content.join("\n"));
  }

  async apply() {
    const resolved = await this._resolveInterface();
    if (!resolved)
      return;
    const {iface, ifacePlugin} = resolved;
    // the conf is fully regenerated, so an expired deprecated address just drops out of the file
    const deprecatedPrefixes = await ifacePlugin.getDeprecatedIPv6Prefixes();
    await this.writeDHCPConfFile(iface, this.networkConfig.tags, this.networkConfig.type, this.networkConfig.range && this.networkConfig.range.from, this.networkConfig.range && this.networkConfig.range.to, this.networkConfig.nameservers,
      this.networkConfig.prefixLen, this.networkConfig.lease, this.networkConfig.raInterval, this.networkConfig.raLifetime, deprecatedPrefixes);
    this._restartService();
  }
}

module.exports = DHCP6Plugin;
