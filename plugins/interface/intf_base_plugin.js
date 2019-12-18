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
const _ = require('lodash');

const r = require('../../util/firerouter');

const exec = require('child-process-promise').exec;

const fs = require('fs');
const Promise = require('bluebird');
const ip = require('ip');

Promise.promisifyAll(fs);

const routing = require('../../util/routing.js');

class InterfaceBasePlugin extends Plugin {

  async flush() {
    if (!this.networkConfig) {
      this.log.error(`Network config for ${this.name} is not set`);
      return;
    }
    if (this.networkConfig.enabled) {
      await exec(`sudo ip addr flush dev ${this.name}`).catch((err) => {
        this.log.error(`Failed to flush ip address of ${this.name}`, err);
      });

      if (this.networkConfig.dhcp) {
        await exec(`cat ${this._getDHClientPidFilePath()}`).then((result) => exec(`sudo kill -9 ${result.stdout.trim()}`)).catch((err) => {});
      }
      // remove resolve file in runtime folder
      await fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name)).catch((err) => {});
        
      // flush related routing tables
      await routing.flushRoutingTable(`${this.name}_local`).catch((err) => {});
      await routing.flushRoutingTable(`${this.name}_default`).catch((err) => {});

      // remove related policy routing rules
      await routing.removeInterfaceRoutingRules(this.name);
      await routing.removeInterfaceGlobalRoutingRules(this.name);

      if (this.networkConfig.gateway || this.networkConfig.dhcp) {
        // considered as WAN interface, accessbile to "routable"
        await routing.removePolicyRoutingRule("all", this.name, routing.RT_ROUTABLE).catch((err) => {});
      } else {
        // considered as LAN interface, add to "routable"
        if (this.networkConfig.ipv4) {
          const cidr = ip.cidrSubnet(this.networkConfig.ipv4);
          await routing.removeRouteFromTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, routing.RT_ROUTABLE).catch((err) => {});
        }
      }
    }
  }

  _getDHClientPidFilePath() {
    return `/run/dhclient.${this.name}.pid`;
  }

  _getDHClientLeaseFilePath() {
    return `/var/lib/dhcp/dhclient.${this.name}.leases`;
  }

  _getResolvConfFilePath() {
    return `/run/resolvconf/interface/${this.name}.dhclient`;
  }

  isWAN() {
    if (!this.networkConfig)
      return false;
    if (this.networkConfig.dhcp || (this.networkConfig.ipv4 && this.networkConfig.gateway))
      return true;
    return false;
  }

  isLAN() {
    if (!this.networkConfig)
      return false;
    if (this.networkConfig.ipv4 && (!this.networkConfig.dhcp && !this.networkConfig.gateway))
      // ip address is set but neither dhcp nor gateway is set, considered as LAN interface
      return true;
    return false;
  }

  async createInterface() {

  }

  async interfaceUpDown() {
    if (this.networkConfig.enabled) {
      await exec(`sudo ip link set ${this.name} up`);
    } else {
      await exec(`sudo ip link set ${this.name} down`);
    }
  }

  async prepareEnvironment() {
    // create routing tables and add rules for interface
    if (this.networkConfig.ipv4 || this.networkConfig.dhcp) {
      await routing.initializeInterfaceRoutingTables(this.name);
      await routing.createInterfaceRoutingRules(this.name);
      await routing.createInterfaceGlobalRoutingRules(this.name);
    }
  }

  async applyIpDnsSettings() {
    if (this.networkConfig.dhcp) {
      await exec(`sudo dhclient -pf ${this._getDHClientPidFilePath()} -lf ${this._getDHClientLeaseFilePath()} -i ${this.name} -e rt_tables="${this.name}_local main" -e default_rt_tables="${this.name}_default main"`).catch((err) => {
        this.fatal(`Failed to enable dhclient on interface ${this.name}: ${err.message}`);
      });

      await fs.accessAsync(r.getInterfaceResolvConfPath(this.name), fs.constants.F_OK).then(() => {
        this.log.info(`Remove old resolv conf for ${this.name}`);
        return fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name));
      }).catch((err) => {});
      await fs.symlinkAsync(this._getResolvConfFilePath(), r.getInterfaceResolvConfPath(this.name));
    } else {
      if (this.networkConfig.ipv4) {
        await exec(`sudo ip addr replace ${this.networkConfig.ipv4} dev ${this.name}`).catch((err) => {
          this.fatal(`Failed to set ipv4 for interface ${this.name}: ${err.message}`);
        })
      }
      if (this.networkConfig.nameservers) {
        const nameservers = this.networkConfig.nameservers.map((nameserver) => `nameserver ${nameserver}`).join("\n");
        await fs.accessAsync(r.getInterfaceResolvConfPath(this.name), fs.constants.F_OK).then(() => {
          return fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name));
        }).catch((err) => {});
        await fs.writeFileAsync(r.getInterfaceResolvConfPath(this.name), nameservers);
      }
    }
  }

  async changeRoutingTables() {
    // if dhcp is set, dhclient should take care of local and default routing table
    if (this.networkConfig.ipv4) {
      const cidr = ip.cidrSubnet(this.networkConfig.ipv4);
      await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, `${this.name}_local`).catch((err) => {});
    }
    if (this.networkConfig.gateway) {
      await routing.addRouteToTable("default", this.networkConfig.gateway, this.name, `${this.name}_default`).catch((err) => {});
    }
    if (this.networkConfig.gateway || this.networkConfig.dhcp) {
      // considered as WAN interface, accessbile to "routable"
      await routing.createPolicyRoutingRule("all", this.name, routing.RT_ROUTABLE, 5001).catch((err) => {});
    } else {
      // considered as LAN interface, add to "routable"
      if (this.networkConfig.ipv4) {
        const cidr = ip.cidrSubnet(this.networkConfig.ipv4);
        await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, routing.RT_ROUTABLE).catch((err) => {});
      }
    }
  }

  async apply() {
    if (!this.networkConfig) {
      this.fatal(`Network config for ${this.name} is not set`);
      return;
    }

    await this.createInterface();

    await this.interfaceUpDown();

    if (!this.networkConfig.enabled)
      return;

    await this.prepareEnvironment();

    await this.applyIpDnsSettings();

    await this.changeRoutingTables();
  }

  async _getSysFSClassNetValue(key) {
    const value = await exec(`sudo cat /sys/class/net/${this.name}/${key}`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => {
      this.log.warn(`Failed to get ${key} of ${this.name}`, err);
      return null;
    })
    return value;
  }

  async state() {
    const mac = await this._getSysFSClassNetValue("address");
    const mtu = await this._getSysFSClassNetValue("mtu");
    const carrier = await this._getSysFSClassNetValue("carrier");
    const duplex = await this._getSysFSClassNetValue("duplex");
    const speed = await this._getSysFSClassNetValue("speed");
    const operstate = await this._getSysFSClassNetValue("operstate");
    const ip4 = await exec(`ip addr show dev ${this.name} | awk '/inet /' | awk '$NF=="${this.name}" {print $2}' | head -n 1`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => null);
    const gateway = await routing.getInterfaceGWIP(this.name);
    const dns = await fs.readFileAsync(r.getInterfaceResolvConfPath(this.name), {encoding: "utf8"}).then(content => content.trim().split("\n").map(line => line.replace("nameserver ", ""))).catch((err) => null);
    return {mac, mtu, carrier, duplex, speed, operstate, ip4, gateway, dns};
  }
}

module.exports = InterfaceBasePlugin;