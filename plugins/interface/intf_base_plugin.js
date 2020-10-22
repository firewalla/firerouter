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
const {Address4, Address6} = require('ip-address');
const uuid = require('uuid');

const wrapIptables = require('../../util/util.js').wrapIptables;

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
    // make sure to stop dhcpv6 client no matter if dhcp6 is enabled
    await exec(`sudo systemctl stop firerouter_dhcpcd6@${this.name}`).catch((err) => {});
    await exec(`sudo ip -6 addr flush dev ${this.name}`).catch((err) => {});
    // regenerate ipv6 link local address based on EUI64
    await exec(`sudo sysctl -w net.ipv6.conf.${this.name.replace(/\./gi, "/")}.addr_gen_mode=0`).catch((err) => {});
    await exec(`sudo sysctl -w net.ipv6.conf.${this.name.replace(/\./gi, "/")}.disable_ipv6=1`).catch((err) => {});
    await exec(`sudo sysctl -w net.ipv6.conf.${this.name.replace(/\./gi, "/")}.disable_ipv6=0`).catch((err) => {});
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

      // remove delegated prefix file in runtime folder
      await fs.unlinkAsync(r.getInterfaceDelegatedPrefixPath(this.name)).catch((err) => {});
        
      // flush related routing tables
      await routing.flushRoutingTable(`${this.name}_local`).catch((err) => {});
      await routing.flushRoutingTable(`${this.name}_default`).catch((err) => {});

      // remove related policy routing rules
      await routing.removeInterfaceRoutingRules(this.name);
      await routing.removeInterfaceGlobalRoutingRules(this.name);
      await routing.removeInterfaceGlobalLocalRoutingRules(this.name);

      if (this.isWAN()) {
        // considered as WAN interface, remove access to "routable"
        await routing.removePolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE, 5001).catch((err) => {});
        await routing.removePolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE, 5001, null, 6).catch((err) => {});
        // restore reverse path filtering settings
        await exec(`sudo sysctl -w net.ipv4.conf.${this.name.replace(/\./gi, "/")}.rp_filter=1`).catch((err) => {});
        // remove fwmark defautl route ip rule
        const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
        await routing.removePolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/0xffff`).catch((err) => {});
        await routing.removePolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/0xffff`, 6).catch((err) =>{});
        await exec(wrapIptables(`sudo iptables -w -t nat -D FR_PREROUTING -i ${this.name} -j CONNMARK --set-xmark ${rtid}/0xffff`)).catch((err) => {
          this.log.error(`Failed to add inbound connmark rule for WAN interface ${this.name}`, err.message);
        });
        await exec(wrapIptables(`sudo ip6tables -w -t nat -D FR_PREROUTING -i ${this.name} -j CONNMARK --set-xmark ${rtid}/0xffff`)).catch((err) => {
          this.log.error(`Failed to add ipv6 inbound connmark rule for WAN interface ${this.name}`, err.message);
        });
      }
      // remove from lan_roubable anyway
      if (this.networkConfig.ipv4) {
        const addr = new Address4(this.networkConfig.ipv4);
        if (addr.isValid()) {
          const networkAddr = addr.startAddress();
          const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
          await routing.removeRouteFromTable(cidr, null, this.name, routing.RT_WAN_ROUTABLE).catch((err) => { });
          if (this.networkConfig.isolated !== true) {
            // routable to/from other routable lans
            await routing.removeRouteFromTable(cidr, null, this.name, routing.RT_LAN_ROUTABLE).catch((err) => { });
          }
        }
      }
      if (this.networkConfig.ipv6 && (_.isString(this.networkConfig.ipv6) || _.isArray(this.networkConfig.ipv6))) {
        const ipv6Addrs = _.isString(this.networkConfig.ipv6) ? [this.networkConfig.ipv6] : this.networkConfig.ipv6;
        for (const addr6 of ipv6Addrs) {
          const addr = new Address6(addr6);
          if (!addr.isValid())
            continue;
          const networkAddr = addr.startAddress();
          const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
          await routing.removeRouteFromTable(cidr, null, this.name, routing.RT_LAN_ROUTABLE, null, 6).catch((err) => {});
        }
      }
      if (this.networkConfig.ipv6DelegateFrom) {
        const fromIface = this.networkConfig.ipv6DelegateFrom;
        const subPrefixId = await this._findSubPrefixId(fromIface);
        if (subPrefixId >= 0) {
          await fs.unlinkAsync(`${r.getInterfacePDCacheDirectory(fromIface)}/${subPrefixId}.${this.name}`).catch((err) =>{});
        }
      }
      if (this.networkConfig.dhcp6) {
        await fs.unlinkAsync(this._getDHCPCD6ConfigPath()).catch((err) => {});
      }
      await routing.removePolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE, 5002).catch((err) => { });
      await routing.removePolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE, 5002, null, 6).catch((err) => { });
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

  _calculateSubPrefix(parentPrefix, subId) {
    const length = parentPrefix.split('/')[1];
    if (length > 64 || subId >= (1 << (64 - length))) {
      this.log.error(`Sub id ${subId} is too large to accomodate in sub prefix ${parentPrefix} for ${this.name}`);
      return null;
    }
    const prefixAddr6 = new Address6(parentPrefix);
    const subIdAddr6 = new Address6(`0000:0000:0000:${subId}::/64`);
    const subPrefix = Address6.fromBigInteger(prefixAddr6.bigInteger().add(subIdAddr6.bigInteger()));
    return `${subPrefix.correctForm()}/64`;
  }

  async _findSubPrefixId(fromIface) {
    const pdCacheDir = r.getInterfacePDCacheDirectory(fromIface);
    let nextId = -1;
    await fs.readdirAsync(pdCacheDir).then((files) => {
      const existingId = files.filter(f => f.endsWith(`.${this.name}`));
      if (existingId.length > 0) {
        nextId = existingId[0].split('.')[0];
        return;
      }
      for (let i = 0; true; i +=1) {
        if (files.filter(f => f.startsWith(`${i}.`)).length == 0) {
          nextId = i;
          return;
        }
      }
    }).catch((err) => {
      this.log.error(`Failed to get next id for prefix delegation from ${fromIface} for ${this.name}`, err.message);
      nextId = -1;
    });
    return nextId;
  }

  async prepareEnvironment() {
    // create runtime directory
    await exec(`mkdir -p ${r.getRuntimeFolder()}/dhcpcd/${this.name}`).catch((err) => {});
    // create routing tables and add rules for interface
    if (this.isWAN() || this.isLAN()) {
      await routing.initializeInterfaceRoutingTables(this.name);
      if (!this.networkConfig.enabled)
        return;
      await routing.createInterfaceRoutingRules(this.name);
      await routing.createInterfaceGlobalRoutingRules(this.name);
      if (this.isLAN())
        await routing.createInterfaceGlobalLocalRoutingRules(this.name);
    }

    if (this.isWAN()) {
      // loosen reverse path filtering settings, this is necessary for dual WAN
      await exec(`sudo sysctl -w net.ipv4.conf.${this.name.replace(/\./gi, "/")}.rp_filter=2`).catch((err) => {});
      // create fwmark default route ip rule for WAN interface. Application should add this fwmark to packets to implement customized default route
      const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
      await routing.createPolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/0xffff`);
      await routing.createPolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/0xffff`, 6);
      await exec(wrapIptables(`sudo iptables -w -t nat -A FR_PREROUTING -i ${this.name} -j CONNMARK --set-xmark ${rtid}/0xffff`)).catch((err) => {
        this.log.error(`Failed to add inbound connmark rule for WAN interface ${this.name}`, err.message);
      });
      await exec(wrapIptables(`sudo ip6tables -w -t nat -A FR_PREROUTING -i ${this.name} -j CONNMARK --set-xmark ${rtid}/0xffff`)).catch((err) => {
        this.log.error(`Failed to add ipv6 inbound connmark rule for WAN interface ${this.name}`, err.message);
      });
    }
  }

  _getDHCPCD6ConfigPath() {
    return `${r.getUserConfigFolder()}/dhcpcd6/${this.name}.conf`;
  }

  async applyIpv6Settings() {
    if (this.networkConfig.dhcp6) {
      // add link local route to interface local and default routing table
      await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_local`, null, 6).catch((err) => {});
      await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_default`, null, 6).catch((err) => {});
      const pdSize = this.networkConfig.dhcp6.pdSize || 60;
      if (pdSize > 64)
        this.fatal(`Prefix delegation size should be no more than 64 on ${this.name}, ${pdSize}`);
      let content = await fs.readFileAsync(`${r.getFireRouterHome()}/etc/dhcpcd.conf.template`, {encoding: "utf8"});
      content = content.replace(/%PD_SIZE%/g, pdSize);
      await fs.writeFileAsync(this._getDHCPCD6ConfigPath(), content);
      // start dhcpcd for SLAAC and stateful DHCPv6 if necessary
      await exec(`sudo systemctl restart firerouter_dhcpcd6@${this.name}`).catch((err) => {
        this.fatal(`Failed to enable dhcpv6 client on interfacer ${this.name}: ${err.message}`);
      });
      // TODO: do not support dns nameservers from DHCPv6 currently
    } else {
      if (this.networkConfig.ipv6 && (_.isString(this.networkConfig.ipv6) || _.isArray(this.networkConfig.ipv6))) {
        // add link local route to interface local and default routing table
        await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_local`, null, 6).catch((err) => {});
        await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_default`, null, 6).catch((err) => {});
        const ipv6Addrs = _.isString(this.networkConfig.ipv6) ? [this.networkConfig.ipv6] : this.networkConfig.ipv6;
        for (const addr6 of ipv6Addrs) {
          await exec(`sudo ip -6 addr add ${addr6} dev ${this.name}`).catch((err) => {
            this.fatal(`Failed to set ipv6 addr ${addr6} for interface ${this.name}`, err.message);
          });
        }
        // this can directly trigger downstream plugins to reapply config adapting to the static IP
        this.propagateConfigChanged(true);
      }
      if (this.networkConfig.ipv6DelegateFrom) {
        const fromIface = this.networkConfig.ipv6DelegateFrom;
        const parentIntfPlugin = pl.getPluginInstance("interface", fromIface);
        if (!parentIntfPlugin)
          this.fatal(`IPv6 delegate from interface ${fromIface} is not found for ${this.name}`);
        this.subscribeChangeFrom(parentIntfPlugin);
        const pdFile = r.getInterfaceDelegatedPrefixPath(fromIface);
        const prefixes = await fs.readFileAsync(pdFile, {encoding: 'utf8'}).then(content => content.trim().split("\n").filter(l => l.length > 0)).catch((err) => {
          this.log.error(`Delegated prefix from ${fromIface} for ${this.name} is not found`);
          return null;
        });
        // assign sub prefix id for this interface
        const subPrefixId = await this._findSubPrefixId(fromIface);
        if (subPrefixId >= 0) {
          // clear previously assigned prefixes in the cache file
          await fs.unlinkAsync(`${r.getInterfacePDCacheDirectory(fromIface)}/${subPrefixId}.${this.name}`).catch((err) =>{});
          if (prefixes && _.isArray(prefixes)) {
            const subPrefixes = [];
            let ipChanged = false;
            for (const prefixMask of prefixes) {
              const subPrefix = this._calculateSubPrefix(prefixMask, subPrefixId);
              if (!subPrefix) {
                this.log.error(`Failed to calculate sub prefix from ${prefixMask} and id ${subPrefixId} for ${this.name}`);
              } else {
                // add link local route to interface local and default routing table
                await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_local`, null, 6).catch((err) => {});
                await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_default`, null, 6).catch((err) => {});
                const addr = new Address6(subPrefix);
                if (!addr.isValid()) {
                  this.log.error(`Invalid sub-prefix ${subPrefix.correctForm()} for ${this.name}`);
                } else {
                  // the suffix of the delegated interface is always 1
                  await exec(`sudo ip -6 addr add ${addr.correctForm()}1/${addr.subnetMask} dev ${this.name}`).catch((err) => {
                    this.log.error(`Failed to set ipv6 addr ${subPrefix} for interface ${this.name}`, err.message);
                  });
                  subPrefixes.push(subPrefix);
                  ipChanged = true;
                }
              }
            }
            if (subPrefixes.length > 0) {
              // write newly assigned prefixes to the cache file
              await fs.writeFileAsync(`${r.getInterfacePDCacheDirectory(fromIface)}/${subPrefixId}.${this.name}`, subPrefixes.join("\n"), { encoding: 'utf8' }).catch((err) => { });
            }
            // trigger reapply of downstream plugins that are dependent on this interface
            if (ipChanged) {
              this.propagateConfigChanged(true);
            }
          }
        }
      }
      // TODO: do not support static dns nameservers for IPv6 currently
    }
  }

  async applyIpSettings() {
    if (this.networkConfig.dhcp) {
      await exec(`sudo systemctl restart firerouter_dhclient@${this.name}`).catch((err) => {
        this.fatal(`Failed to enable dhclient on interface ${this.name}: ${err.message}`);
      });
    } else {
      if (this.networkConfig.ipv4) {
        await exec(`sudo ip addr replace ${this.networkConfig.ipv4} dev ${this.name}`).catch((err) => {
          this.fatal(`Failed to set ipv4 for interface ${this.name}: ${err.message}`);
        });
        // this can directly trigger downstream plugins to reapply config adapting to the static IP
        this.propagateConfigChanged(true);
      }
    }

    await this.applyIpv6Settings();
  }

  async applyDnsSettings() {
    if (this.networkConfig.dhcp || (this.networkConfig.nameservers && this.networkConfig.nameservers.length > 0)) {
      await fs.accessAsync(r.getInterfaceResolvConfPath(this.name), fs.constants.F_OK).then(() => {
        this.log.info(`Remove old resolv conf for ${this.name}`);
        return fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name));
      }).catch((err) => {});
      // specified DNS nameservers supersedes those assigned by DHCP
      if (this.networkConfig.nameservers && this.networkConfig.nameservers.length > 0) {
        const nameservers = this.networkConfig.nameservers.map((nameserver) => `nameserver ${nameserver}`).join("\n");
        await fs.writeFileAsync(r.getInterfaceResolvConfPath(this.name), nameservers);
      } else {
        await fs.symlinkAsync(this._getResolvConfFilePath(), r.getInterfaceResolvConfPath(this.name));
      }
    }
  }

  async changeRoutingTables() {
    // if dhcp/dhcp6 is set, dhclient/dhcpcd6 should take care of local and default routing table
    if (this.networkConfig.ipv4) {
      const addr = new Address4(this.networkConfig.ipv4);
      if (!addr.isValid())
        this.fatal(`Invalid ipv4 address ${this.networkConfig.ipv4} for ${this.name}`);
      const networkAddr = addr.startAddress();
      const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
      await routing.addRouteToTable(cidr, null, this.name, `${this.name}_local`).catch((err) => {});
      await routing.addRouteToTable(cidr, null, this.name, `${this.name}_default`).catch((err) => {});
    }
    if (this.networkConfig.ipv6 && (_.isString(this.networkConfig.ipv6) || _.isArray(this.networkConfig.ipv6))) {
      const ipv6Addrs = _.isString(this.networkConfig.ipv6) ? [this.networkConfig.ipv6] : this.networkConfig.ipv6;
      for (const addr6 of ipv6Addrs) {
        const addr = new Address6(addr6);
        if (!addr.isValid())
          this.fatal(`Invalid ipv6 address ${addr6} for ${this.name}`);
        const networkAddr = addr.startAddress();
        const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
        await routing.addRouteToTable(cidr, null, this.name, `${this.name}_local`, null, 6).catch((err) => {});
        await routing.addRouteToTable(cidr, null, this.name, `${this.name}_default`, null, 6).catch((err) => {});
      }
    }
    if (this.networkConfig.ipv6DelegateFrom) {
      // read delegated sub prefixes from cache file
      const subPrefixId = await this._findSubPrefixId(this.networkConfig.ipv6DelegateFrom);
      const prefixes = await fs.readFileAsync(`${r.getInterfacePDCacheDirectory(this.networkConfig.ipv6DelegateFrom)}/${subPrefixId}.${this.name}`, {encoding: 'utf8'}).then((content) => content.trim().split('\n').filter(l => l.length > 0)).catch((err) => {
        this.log.error(`Failed to read sub prefixes for ${this.name}`, err.message);
        return [];
      });
      for (const prefix of prefixes) {
        const addr = new Address6(prefix);
        if (!addr.isValid()) {
          this.log.error(`Invalid sub-prefix ${prefix} for ${this.name}`);
        } else {
          const networkAddr = addr.startAddress();
          const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
          await routing.addRouteToTable(cidr, null, this.name, `${this.name}_local`, null, 6).catch((err) => {});
          await routing.addRouteToTable(cidr, null, this.name, `${this.name}_default`, null, 6).catch((err) => {});
        }
      }
    }
    if (this.networkConfig.gateway) {
      await routing.addRouteToTable("default", this.networkConfig.gateway, this.name, `${this.name}_default`).catch((err) => {});
    }
    if (this.networkConfig.gateway6) {
      await routing.addRouteToTable("default", this.networkConfig.gateway6, this.name, `${this.name}_default`, null, 6).catch((err) => {});
    }
    if (this.isWAN()) {
      // considered as WAN interface, accessbile to "wan_routable"
      await routing.createPolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE, 5001).catch((err) => {});
      await routing.createPolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE, 5001, null, 6).catch((err) => {});
    }
    if (this.isLAN()) {
      // considered as LAN interface, add to "lan_routable" and "wan_routable"
      if (this.networkConfig.ipv4) {
        const addr = new Address4(this.networkConfig.ipv4);
        if (!addr.isValid())
          this.fatal(`Invalid ipv4 address ${this.networkConfig.ipv4} for ${this.name}`);
        const networkAddr = addr.startAddress();
        const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
        await routing.addRouteToTable(cidr, null, this.name, routing.RT_WAN_ROUTABLE).catch((err) => {});
        if (this.networkConfig.isolated !== true) {
          // routable to/from other routable lans
          await routing.addRouteToTable(cidr, null, this.name, routing.RT_LAN_ROUTABLE).catch((err) => {});
        }
      }
      if (this.networkConfig.ipv6 && (_.isString(this.networkConfig.ipv6) || _.isArray(this.networkConfig.ipv6))) {
        const ipv6Addrs = _.isString(this.networkConfig.ipv6) ? [this.networkConfig.ipv6] : this.networkConfig.ipv6;
        for (const addr6 of ipv6Addrs) {
          const addr = new Address6(addr6);
          if (!addr.isValid())
            this.fatal(`Invalid ipv6 address ${addr6} for ${this.name}`);
          const networkAddr = addr.startAddress();
          const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
          await routing.addRouteToTable(cidr, null, this.name, routing.RT_WAN_ROUTABLE, null, 6).catch((err) => {});
          if (this.networkConfig.isolated !== true) {
            await routing.addRouteToTable(cidr, null, this.name, routing.RT_LAN_ROUTABLE, null, 6).catch((err) => {});
          }
        }
      }
      if (this.networkConfig.ipv6DelegateFrom) {
        // read delegated sub prefixes from cache file
        const subPrefixId = await this._findSubPrefixId(this.networkConfig.ipv6DelegateFrom);
        const prefixes = await fs.readFileAsync(`${r.getInterfacePDCacheDirectory(this.networkConfig.ipv6DelegateFrom)}/${subPrefixId}.${this.name}`, {encoding: 'utf8'}).then((content) => content.trim().split('\n').filter(l => l.length > 0)).catch((err) => {
          this.log.error(`Failed to read sub prefixes for ${this.name}`, err.message);
          return [];
        });
        for (const prefix of prefixes) {
          const addr = new Address6(prefix);
          if (!addr.isValid()) {
            this.log.error(`Invalid sub-prefix ${prefix} for ${this.name}`);
          } else {
            const networkAddr = addr.startAddress();
            const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
            await routing.addRouteToTable(cidr, null, this.name, routing.RT_WAN_ROUTABLE, null, 6).catch((err) => {});
            if (this.networkConfig.isolated !== true) {
              await routing.addRouteToTable(cidr, null, this.name, routing.RT_LAN_ROUTABLE, null, 6).catch((err) => {});
            }
          }
        }
      }
      if (this.networkConfig.isolated !== true) {
        await routing.createPolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE, 5002).catch((err) => {});
        await routing.createPolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE, 5002, null, 6).catch((err) => {});
      }
    }
  }

  async updateRouteForDNS() {
    // TODO: there is no IPv6 DNS currently
    const dns = await this.getDNSNameservers();
    const gateway = await routing.getInterfaceGWIP(this.name, 4);
    if (!_.isArray(dns) || dns.length === 0 || !gateway)
      return;
    for (const dnsIP of dns) {
      await routing.addRouteToTable(dnsIP, gateway, this.name, `${this.name}_default`, null, 4, true).catch((err) => {});
    }
  }

  async setHardwareAddress() {
    if (this.networkConfig.hwAddr)
      await exec(`sudo ip link set ${this.name} address ${this.networkConfig.hwAddr}`).catch((err) => {
        this.log.error(`Failed to set hardware address of ${this.name} to ${this.networkConfig.hwAddr}`, err.message);
      });
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

    await this.setHardwareAddress();

    await this.applyIpSettings();

    await this.applyDnsSettings();

    await this.changeRoutingTables();

    await this.updateRouteForDNS();
  }

  async _getSysFSClassNetValue(key) {
    const value = await exec(`sudo cat /sys/class/net/${this.name}/${key}`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => {
      this.log.debug(`Failed to get ${key} of ${this.name}`, err.message);
      return null;
    })
    return value;
  }

  _getWANConnState(name) {
    const routingPlugin = pl.getPluginInstance("routing", "global");
    if (routingPlugin) {
      return routingPlugin.getWANConnState(name);
    }
    return null;
  }

  async getDNSNameservers() {
    const dns = await fs.readFileAsync(r.getInterfaceResolvConfPath(this.name), {encoding: "utf8"}).then(content => content.trim().split("\n").filter(line => line.startsWith("nameserver")).map(line => line.replace("nameserver", "").trim())).catch((err) => null);
    return dns;
  }

  async state() {
    const mac = await this._getSysFSClassNetValue("address");
    const mtu = await this._getSysFSClassNetValue("mtu");
    const carrier = await this._getSysFSClassNetValue("carrier");
    const duplex = await this._getSysFSClassNetValue("duplex");
    const speed = await this._getSysFSClassNetValue("speed");
    const operstate = await this._getSysFSClassNetValue("operstate");
    const txBytes = await this._getSysFSClassNetValue("statistics/tx_bytes");
    const rxBytes = await this._getSysFSClassNetValue("statistics/rx_bytes");
    const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
    let ip4 = await exec(`ip addr show dev ${this.name} | awk '/inet /' | awk '$NF=="${this.name}" {print $2}' | head -n 1`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => null) || null;
    if (ip4 && ip4.length > 0 && !ip4.includes("/"))
      ip4 = `${ip4}/32`;
    let ip6 = await exec(`ip addr show dev ${this.name} | awk '/inet6 /' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => null) || null;
    if (ip6)
      ip6 = ip6.split("\n").filter(l => l.length > 0);
    const gateway = await routing.getInterfaceGWIP(this.name) || null;
    const gateway6 = await routing.getInterfaceGWIP(this.name, 6) || null;
    const dns = await this.getDNSNameservers();
    let wanConnState = null;
    if (this.isWAN())
      wanConnState = this._getWANConnState(this.name);
    return {mac, mtu, carrier, duplex, speed, operstate, txBytes, rxBytes, ip4, ip6, gateway, gateway6, dns, rtid, wanConnState};
  }

  onEvent(e) {
    if (!event.isLoggingSuppressed(e))
      this.log.info(`Received event on ${this.name}`, e);
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
      case event.EVENT_PD_CHANGE: {
        const payload = event.getEventPayload(e);
        const iface = payload.intf;
        if (iface && this.networkConfig.ipv6DelegateFrom === iface) {
          // the interface from which prefix is delegated is changed, need to reapply config
          this._reapplyNeeded = true;
          pl.scheduleReapply();
        }
      }
      case event.EVENT_IP_CHANGE: {
        const payload = event.getEventPayload(e);
        const iface = payload.intf;
        if (iface === this.name && this.isWAN()) {
          // update route for DNS from DHCP
          this.updateRouteForDNS().catch((err) => {
            this.log.error(`Failed to update route for DNS on ${this.name}`, err.message);
          });
        }
      }
      default:
    }
  }
}

module.exports = InterfaceBasePlugin;