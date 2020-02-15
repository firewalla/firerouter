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
const _ = require('lodash');

const r = require('../../util/firerouter');

const exec = require('child-process-promise').exec;

const fs = require('fs');
const Promise = require('bluebird');
const ip = require('ip');
const uuid = require('uuid');

const event = require('../../core/event.js');

Promise.promisifyAll(fs);

const routing = require('../../util/routing.js');

class InterfaceBasePlugin extends Plugin {

  async flushIP() {
    await exec(`sudo ip addr flush dev ${this.name}`).catch((err) => {
      this.log.error(`Failed to flush ip address of ${this.name}`, err);
    });
    // make sure to stop dhclient no matter if dhcp is enabled
    await exec(`sudo systemctl stop firerouter_dhclient@${this.name}`).catch((err) => {});
  }

  async flush() {
    if (!this.networkConfig) {
      this.log.error(`Network config for ${this.name} is not set`);
      return;
    }
    if (this.networkConfig.enabled) {
      await this.flushIP();
      // remove resolve file in runtime folder
      await fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name)).catch((err) => {});
        
      // flush related routing tables
      await routing.flushRoutingTable(`${this.name}_local`).catch((err) => {});
      await routing.flushRoutingTable(`${this.name}_default`).catch((err) => {});

      // remove related policy routing rules
      await routing.removeInterfaceRoutingRules(this.name);
      await routing.removeInterfaceGlobalRoutingRules(this.name);

      if (this.isWAN()) {
        // considered as WAN interface, remove access to "routable"
        await routing.removePolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE).catch((err) => {});
        // restore reverse path filtering settings
        await exec(`sudo sysctl -w net.ipv4.conf.${this.name}.rp_filter=1`).catch((err) => {});
        // remove fwmark defautl route ip rule
        const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
        await routing.removePolicyRoutingRule("all", null, `${this.name}_default`, `${rtid}/0xffff`);
      } else {
        // considered as LAN interface, remove from "routable"
        if (this.networkConfig.ipv4) {
          const cidr = ip.cidrSubnet(this.networkConfig.ipv4);
          await routing.removeRouteFromTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, routing.RT_WAN_ROUTABLE).catch((err) => {});
          if (this.networkConfig.isolated !== true) {
            // routable to/from other routable lans
            await routing.removeRouteFromTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, routing.RT_LAN_ROUTABLE).catch((err) => {});
          }
        }
        await routing.removePolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE).catch((err) => {});
      }
    }
  }

  async configure(networkConfig) {
    await super.configure(networkConfig);
    if (!networkConfig.meta)
      networkConfig.meta = {};
    if (!networkConfig.meta.uuid)
      networkConfig.meta.uuid = uuid.v4();
    this.phyName = this.name;
    if (this.name.endsWith(":0")) {
      // alias interface, strip suffix in physical dev name 
      this.phyName = this.name.substring(0, this.name.length - 2);
    }
  }

  _getResolvConfFilePath() {
    return `/run/resolvconf/interface/${this.name}.dhclient`;
  }

  isWAN() {
    if (!this.networkConfig)
      return false;
    // user defined type in meta supersedes default determination logic
    if (this.networkConfig.meta && this.networkConfig.meta.type === "wan") {
      return true;
    }
    if (this.networkConfig.dhcp || (this.networkConfig.ipv4 && this.networkConfig.gateway))
      return true;
    return false;
  }

  isLAN() {
    if (!this.networkConfig)
      return false;
    // user defined type in meta supersedes default determination logic
    if (this.networkConfig.meta && this.networkConfig.meta.type === "lan") {
      return true;
    }
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
    if (this.isWAN() || this.isLAN()) {
      await routing.initializeInterfaceRoutingTables(this.name);
      if (!this.networkConfig.enabled)
        return;
      await routing.createInterfaceRoutingRules(this.name);
      await routing.createInterfaceGlobalRoutingRules(this.name);
    }

    if (this.isWAN()) {
      // loosen reverse path filtering settings, this is necessary for dual WAN
      await exec(`sudo sysctl -w net.ipv4.conf.${this.name}.rp_filter=2`).catch((err) => {});
      // create fwmark default route ip rule for WAN interface. Application should add this fwmark to packets to implement customized default route
      const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
      await routing.createPolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/0xffff`);
    }
  }

  async applyIpDnsSettings() {
    if (this.networkConfig.dhcp) {
      await exec(`sudo systemctl restart firerouter_dhclient@${this.name}`).catch((err) => {
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
    if (this.isWAN()) {
      // considered as WAN interface, accessbile to "routable"
      await routing.createPolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE, 5001).catch((err) => {});
    } else {
      // considered as LAN interface, add to "routable"
      if (this.networkConfig.ipv4) {
        const cidr = ip.cidrSubnet(this.networkConfig.ipv4);
        await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, routing.RT_WAN_ROUTABLE).catch((err) => {});
        if (this.networkConfig.isolated !== true) {
          // routable to/from other routable lans
          await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, routing.RT_LAN_ROUTABLE).catch((err) => {});
        }
      }
      if (this.networkConfig.isolated !== true)
        await routing.createPolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE, 5002).catch((err) => {});
    }
  }

  async apply() {
    if (!this.networkConfig) {
      this.fatal(`Network config for ${this.name} is not set`);
      return;
    }

    await this.createInterface();

    await this.prepareEnvironment();

    await this.interfaceUpDown();

    if (!this.networkConfig.enabled)
      return;

    await this.applyIpDnsSettings();

    await this.changeRoutingTables();
  }

  async _getSysFSClassNetValue(key) {
    const value = await exec(`sudo cat /sys/class/net/${this.name}/${key}`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => {
      this.log.debug(`Failed to get ${key} of ${this.name}`, err.message);
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
    const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
    let ip4 = await exec(`ip addr show dev ${this.name} | awk '/inet /' | awk '$NF=="${this.name}" {print $2}' | head -n 1`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => null) || null;
    if (ip4 && ip4.length > 0 && !ip4.includes("/"))
      ip4 = `${ip4}/32`;
    let ip6 = await exec(`ip addr show dev ${this.name} | awk '/inet6 /' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => null) || null;
    if (ip6)
      ip6 = ip6.split("\n").filter(l => l.length > 0);
    const gateway = await routing.getInterfaceGWIP(this.name) || null;
    const dns = await fs.readFileAsync(r.getInterfaceResolvConfPath(this.name), {encoding: "utf8"}).then(content => content.trim().split("\n").filter(line => line.startsWith("nameserver")).map(line => line.replace("nameserver", "").trim())).catch((err) => null);
    return {mac, mtu, carrier, duplex, speed, operstate, ip4, ip6, gateway, dns, rtid};
  }

  onEvent(e) {
    this.log.info("Received event", e);
    const eventType = event.getEventType(e);
    switch (eventType) {
      case event.EVENT_IF_UP: {
        if (this.isWAN()) {
          // WAN interface plugged, need to reapply WAN interface config
          this._reapplyNeeded = true;
          pl.scheduleReapply();
        }
        break;
      }
      default:
    }
  }
}

module.exports = InterfaceBasePlugin;