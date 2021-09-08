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
const era = require('../../event/EventRequestApi.js');
const EventConstants = require('../../event/EventConstants.js');

Promise.promisifyAll(fs);

const routing = require('../../util/routing.js');

class InterfaceBasePlugin extends Plugin {

  async isInterfacePresent() {
    return fs.accessAsync(r.getInterfaceSysFSDirectory(this.name), fs.constants.F_OK).then(() => true).catch((err) => false);
  }

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
        await routing.removePolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/${routing.MASK_REG}`).catch((err) => {});
        await routing.removePolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/${routing.MASK_REG}`, 6).catch((err) =>{});
        await exec(wrapIptables(`sudo iptables -w -t nat -D FR_PREROUTING -i ${this.name} -m connmark --mark 0x0/${routing.MASK_ALL} -j CONNMARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
          this.log.error(`Failed to add inbound connmark rule for WAN interface ${this.name}`, err.message);
        });
        await exec(wrapIptables(`sudo ip6tables -w -t nat -D FR_PREROUTING -i ${this.name} -m connmark --mark 0x0/${routing.MASK_ALL} -j CONNMARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
          this.log.error(`Failed to add ipv6 inbound connmark rule for WAN interface ${this.name}`, err.message);
        });
        await this.unmarkOutputConnection(rtid).catch((err) => {
          this.log.error(`Failed to remove outgoing mark for WAN interface ${this.name}`, err.message);
        });
      }
      // remove from lan_roubable anyway
      if (this.networkConfig.ipv4 && _.isString(this.networkConfig.ipv4) || this.networkConfig.ipv4s && _.isArray(this.networkConfig.ipv4s)) {
        let ipv4Addrs = [];
        if (this.networkConfig.ipv4 && _.isString(this.networkConfig.ipv4))
          ipv4Addrs.push(this.networkConfig.ipv4);
        if (this.networkConfig.ipv4s && _.isArray(this.networkConfig.ipv4s))
          Array.prototype.push.apply(ipv4Addrs, this.networkConfig.ipv4s);
        ipv4Addrs = ipv4Addrs.filter((v, i, a) => a.indexOf(v) === i);
        for (const addr4 of ipv4Addrs) {
          const addr = new Address4(addr4);
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
        await fs.unlinkAsync(`${r.getInterfacePDCacheDirectory(fromIface)}/${this.name}`).catch((err) =>{});
      }
      if (this.networkConfig.dhcp6) {
        await fs.unlinkAsync(this._getDHCPCD6ConfigPath()).catch((err) => {});
      }
      if (this.networkConfig.dhcp) {
        await fs.unlinkAsync(this._getDHClientConfigPath()).catch((err) => {});
      }
      await routing.removePolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE, 5002).catch((err) => { });
      await routing.removePolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE, 5002, null, 6).catch((err) => { });
    }

    if (this.networkConfig.hwAddr) {
      const permAddr = await exec(`sudo ethtool -P ${this.name} | awk '{print $3}'`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => {
        this.log.error(`Failed to get permanent address of ${this.name}`, err.message);
        return null;
      });
      if (permAddr) {
        await exec(`sudo ip link set ${this.name} address ${permAddr}`).catch((err) => {
          this.log.error(`Failed to revert hardware address of ${this.name} to ${permAddr}`, err.message);
        });
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
    if (this.networkConfig.dhcp || ((this.networkConfig.ipv4 || this.networkConfig.ipv4s) && this.networkConfig.gateway))
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
    if ((this.networkConfig.ipv4 || this.networkConfig.ipv4s) && (!this.networkConfig.dhcp && !this.networkConfig.gateway))
      // ip address is set but neither dhcp nor gateway is set, considered as LAN interface
      return true;
    return false;
  }

  async createInterface() {
    return true;
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

  async _findSubPrefix(fromIface, prefixes) {
    const pdCacheDir = r.getInterfacePDCacheDirectory(fromIface);
    if (!_.isArray(prefixes))
      return null;
    const prefixIfaceMap = {};
    const files = await fs.readdirAsync(pdCacheDir);
    for (const file of files) {
      const addr = await fs.readFileAsync(`${pdCacheDir}/${file}`, { encoding: 'utf8' }).then(r => r.trim());
      if (addr) {
        const addr6 = new Address6(addr);
        if (addr6.isValid()) {
          prefixIfaceMap[addr] = file;
          if (file === this.name
            && prefixes.some(p => {
              const prefix6 = new Address6(p);
              return prefix6.isValid() && addr6.isInSubnet(prefix6)
            })
          ) {
            return addr;
          }
        }
      }
    }
    for (const prefix of prefixes) {
      for (let i = 0; true; i++) {
        const addr = this._calculateSubPrefix(prefix, i);
        if (!addr)
          break;
        if (!prefixIfaceMap.hasOwnProperty(addr))
          return addr;
      }
    }
    return null;
  }

  async prepareEnvironment() {
    // create runtime directory
    await exec(`mkdir -p ${r.getInterfacePDCacheDirectory(this.name)}`).catch((err) => {});
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
      await routing.createPolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/${routing.MASK_REG}`);
      await routing.createPolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/${routing.MASK_REG}`, 6);
      await exec(wrapIptables(`sudo iptables -w -t nat -A FR_PREROUTING -i ${this.name} -m connmark --mark 0x0/${routing.MASK_ALL} -j CONNMARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => { // do not reset connmark if it is already set in mangle table
        this.log.error(`Failed to add inbound connmark rule for WAN interface ${this.name}`, err.message);
      });
      await exec(wrapIptables(`sudo ip6tables -w -t nat -A FR_PREROUTING -i ${this.name} -m connmark --mark 0x0/${routing.MASK_ALL} -j CONNMARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
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
      const numOfPDs = this.networkConfig.dhcp6.numOfPDs || 1;
      const pdOpts = [];
      for (let i = 1; i <= numOfPDs; i++) {
        pdOpts.push(`ia_pd ${i}/::/${pdSize} not_exist/1`);
      }
      content = content.replace(/%IA_PD_OPTS%/g, pdOpts.join('\n'));
      await fs.writeFileAsync(this._getDHCPCD6ConfigPath(), content);
      // start dhcpcd for SLAAC and stateful DHCPv6 if necessary
      await exec(`sudo systemctl restart firerouter_dhcpcd6@${this.name}`).catch((err) => {
        this.fatal(`Failed to enable dhcpv6 client on interface ${this.name}: ${err.message}`);
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
      }
      if (this.networkConfig.ipv6DelegateFrom) {
        const fromIface = this.networkConfig.ipv6DelegateFrom;
        const parentIntfPlugin = pl.getPluginInstance("interface", fromIface);
        if (!parentIntfPlugin)
          this.fatal(`IPv6 delegate from interface ${fromIface} is not found for ${this.name}`);
        this.subscribeChangeFrom(parentIntfPlugin);
        if (await parentIntfPlugin.isInterfacePresent() === false) {
          this.log.warn(`Interface ${fromIface} is not present yet`);
        } else {
          // assign sub prefix id for this interface
          const pdFile = r.getInterfaceDelegatedPrefixPath(fromIface);
          const prefixes = await fs.readFileAsync(pdFile, {encoding: 'utf8'}).then(content => content.trim().split("\n").filter(l => l.length > 0)).catch((err) => {
            this.log.error(`Delegated prefix from ${fromIface} for ${this.name} is not found`);
            return null;
          });
          const subPrefix = await this._findSubPrefix(fromIface, prefixes);
          let ipChanged = false;
          if (subPrefix) {
            // clear previously assigned prefixes in the cache file
            await fs.unlinkAsync(`${r.getInterfacePDCacheDirectory(fromIface)}/${this.name}`).catch((err) =>{});
            // add link local route to interface local and default routing table
            await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_local`, null, 6).catch((err) => { });
            await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_default`, null, 6).catch((err) => { });
            const addr = new Address6(subPrefix);
            if (!addr.isValid()) {
              this.log.error(`Invalid sub-prefix ${subPrefix.correctForm()} for ${this.name}`);
            } else {
              // the suffix of the delegated interface is always 1
              await exec(`sudo ip -6 addr add ${addr.correctForm()}1/${addr.subnetMask} dev ${this.name}`).catch((err) => {
                this.log.error(`Failed to set ipv6 addr ${subPrefix} for interface ${this.name}`, err.message);
              });
              ipChanged = true;
            }
            if (ipChanged) {
              // write newly assigned prefixes to the cache file
              await fs.writeFileAsync(`${r.getInterfacePDCacheDirectory(fromIface)}/${this.name}`, subPrefix, { encoding: 'utf8' }).catch((err) => { });
              // trigger reapply of downstream plugins that are dependent on this interface
              this.propagateConfigChanged(true);
            }
          }
        }
      }
      // TODO: do not support static dns nameservers for IPv6 currently
    }
  }

  _getDHClientConfigPath() {
    return `${r.getUserConfigFolder()}/dhclient/${this.name}.conf`;
  }

  isStaticIP() {
    // either IPv4 or IPv6 is static
    if (this.networkConfig.ipv4 || (this.networkConfig.ipv4s && this.networkConfig.ipv4s.length > 0) || (this.networkConfig.ipv6 && this.networkConfig.ipv6.length > 0))
      return true;
    return false;
  }

  async applyIpSettings() {
    if (this.networkConfig.dhcp) {
      const dhcpOptions = [];
      if (this.networkConfig.dhcpOptions) {
        for (const option of Object.keys(this.networkConfig.dhcpOptions)) {
          dhcpOptions.push(`send ${option} "${this.networkConfig.dhcpOptions[option]}";`);
        }
      }
      let dhclientConf = await fs.readFileAsync(`${r.getFireRouterHome()}/etc/dhclient.conf.template`, {encoding: "utf8"});
      dhclientConf = dhclientConf.replace(/%ADDITIONAL_OPTIONS%/g, dhcpOptions.join("\n"));
      await fs.writeFileAsync(this._getDHClientConfigPath(), dhclientConf);
      await exec(`sudo systemctl restart firerouter_dhclient@${this.name}`).catch((err) => {
        this.fatal(`Failed to enable dhclient on interface ${this.name}: ${err.message}`);
      });
    } else {
      if (this.networkConfig.ipv4 && _.isString(this.networkConfig.ipv4) || this.networkConfig.ipv4s && _.isArray(this.networkConfig.ipv4s)) {
        let ipv4Addrs = [];
        if (this.networkConfig.ipv4 && _.isString(this.networkConfig.ipv4))
          ipv4Addrs.push(this.networkConfig.ipv4);
        if (this.networkConfig.ipv4s && _.isArray(this.networkConfig.ipv4s))
          Array.prototype.push.apply(ipv4Addrs, this.networkConfig.ipv4s);
        ipv4Addrs = ipv4Addrs.filter((v, i, a) => a.indexOf(v) === i);
        for (const addr4 of ipv4Addrs) {
          await exec(`sudo ip addr add ${addr4} dev ${this.name}`).catch((err) => {
            this.fatal(`Failed to set ipv4 ${addr4} for interface ${this.name}: ${err.message}`);
          });
        }
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
    if (this.networkConfig.ipv4 && _.isString(this.networkConfig.ipv4) || this.networkConfig.ipv4s && _.isArray(this.networkConfig.ipv4s)) {
      let ipv4Addrs = [];
      if (this.networkConfig.ipv4 && _.isString(this.networkConfig.ipv4))
        ipv4Addrs.push(this.networkConfig.ipv4);
      if (this.networkConfig.ipv4s && _.isArray(this.networkConfig.ipv4s))
        Array.prototype.push.apply(ipv4Addrs, this.networkConfig.ipv4s);
      ipv4Addrs = ipv4Addrs.filter((v, i, a) => a.indexOf(v) === i);
      for (const addr4 of ipv4Addrs) {
        const addr = new Address4(addr4);
        if (!addr.isValid())
          this.fatal(`Invalid ipv4 address ${addr4} for ${this.name}`);
        const networkAddr = addr.startAddress();
        const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
        await routing.addRouteToTable(cidr, null, this.name, `${this.name}_local`).catch((err) => {});
        await routing.addRouteToTable(cidr, null, this.name, `${this.name}_default`).catch((err) => {});
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
        await routing.addRouteToTable(cidr, null, this.name, `${this.name}_local`, null, 6).catch((err) => {});
        await routing.addRouteToTable(cidr, null, this.name, `${this.name}_default`, null, 6).catch((err) => {});
      }
    }
    if (this.networkConfig.ipv6DelegateFrom) {
      // read delegated sub prefixes from cache file
      const prefixes = await fs.readFileAsync(`${r.getInterfacePDCacheDirectory(this.networkConfig.ipv6DelegateFrom)}/${this.name}`, {encoding: 'utf8'}).then((content) => content.trim().split('\n').filter(l => l.length > 0)).catch((err) => {
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
    if (this.isWAN()) {
      // add an unreachable route with lower preference in routing table to prevent traffic from falling through to other WAN's routing table
      await routing.addRouteToTable("default", null, null, `${this.name}_default`, 65536, 4, false, "unreachable").catch((err) => {});
      await routing.addRouteToTable("default", null, null, `${this.name}_default`, 65536, 6, false, "unreachable").catch((err) => {});
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
      if (this.networkConfig.ipv4 && _.isString(this.networkConfig.ipv4) || this.networkConfig.ipv4s && _.isArray(this.networkConfig.ipv4s)) {
        let ipv4Addrs = [];
        if (this.networkConfig.ipv4 && _.isString(this.networkConfig.ipv4))
          ipv4Addrs.push(this.networkConfig.ipv4);
        if (this.networkConfig.ipv4s && _.isArray(this.networkConfig.ipv4s))
          Array.prototype.push.apply(ipv4Addrs, this.networkConfig.ipv4s);
        ipv4Addrs = ipv4Addrs.filter((v, i, a) => a.indexOf(v) === i);
        for (const addr4 of ipv4Addrs) {
          const addr = new Address4(addr4);
          if (!addr.isValid())
            this.fatal(`Invalid ipv4 address ${addr4} for ${this.name}`);
          const networkAddr = addr.startAddress();
          const cidr = `${networkAddr.correctForm()}/${addr.subnetMask}`;
          await routing.addRouteToTable(cidr, null, this.name, routing.RT_WAN_ROUTABLE).catch((err) => {});
          if (this.networkConfig.isolated !== true) {
            // routable to/from other routable lans
            await routing.addRouteToTable(cidr, null, this.name, routing.RT_LAN_ROUTABLE).catch((err) => {});
          }
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
        const prefixes = await fs.readFileAsync(`${r.getInterfacePDCacheDirectory(this.networkConfig.ipv6DelegateFrom)}/${this.name}`, {encoding: 'utf8'}).then((content) => content.trim().split('\n').filter(l => l.length > 0)).catch((err) => {
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

  async unmarkOutputConnection(rtid) {
    if (_.isArray(this._srcIPs)) {
      for (const ip4Addr of this._srcIPs) {
        await exec(wrapIptables(`sudo iptables -w -t mangle -D FR_OUTPUT -s ${ip4Addr} -m conntrack --ctdir ORIGINAL -j MARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
          this.log.error(`Failed to remove outgoing MARK rule for WAN interface ${this.name} ${ipv4Addr}`, err.message);
        });
      }
    }
    this._srcIPs = [];
  }

  async markOutputConnection() {
    const ip4s = await this.getIPv4Addresses();
    const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
    if (ip4s && rtid) {
      const srcIPs = [];
      for (const ip4 of ip4s) {
        const ip4Addr = ip4.split('/')[0];
        await exec(wrapIptables(`sudo iptables -w -t mangle -A FR_OUTPUT -s ${ip4Addr} -m conntrack --ctdir ORIGINAL -j MARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
          this.log.error(`Failed to add outgoing MARK rule for WAN interface ${this.name} ${ipv4Addr}`, err.message);
        });
        srcIPs.push(ip4Addr);
      }
      this._srcIPs = srcIPs;
    }
  }

  async setHardwareAddress() {
    if (this.networkConfig.hwAddr)
      await exec(`sudo ip link set ${this.name} address ${this.networkConfig.hwAddr}`).catch((err) => {
        this.log.error(`Failed to set hardware address of ${this.name} to ${this.networkConfig.hwAddr}`, err.message);
      });
  }

  async setSysOpts() {
    if (this.networkConfig.sysOpts) {
      for (const key of Object.keys(this.networkConfig.sysOpts)) {
        const value = this.networkConfig.sysOpts[key];
        await exec(`sudo bash -c 'echo ${value} > /sys/class/net/${this.name}/${key}'`).catch((err) => {
          this.log.error(`Failed to set sys opt ${key} of ${this.name} to ${value}`, err.message);
        });
      }
    }
  }

  async apply() {
    if (!this.networkConfig) {
      this.fatal(`Network config for ${this.name} is not set`);
      return;
    }

    if (this.networkConfig.allowHotplug === true) {
      const ifRegistered = await this.isInterfacePresent();
      if (!ifRegistered)
        return;
    }

    const ifCreated = await this.createInterface();
    if (!ifCreated) {
      this.log.warn(`Unable to create interface ${this.name}`);
      return;
    }

    await this.prepareEnvironment();

    await this.interfaceUpDown();

    if (!this.networkConfig.enabled)
      return;

    await this.setHardwareAddress();

    await this.applyIpSettings();

    await this.applyDnsSettings();

    await this.changeRoutingTables();

    if (this.isWAN()) {
      this._wanStatus = {};

      await this.updateRouteForDNS();

      await this.markOutputConnection();
    }

    await this.setSysOpts();
  }

  async _getSysFSClassNetValue(key) {
    const file = `/sys/class/net/${this.name}/${key}`;
    return fs.readFileAsync(file, "utf8").then(content => content.trim()).catch((err) => {
      this.log.debug(`Failed to get ${key} of ${this.name}`, err.message);
      return null;
    });
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

  async getIPv4Addresses() {
    let ip4s = await exec(`ip addr show dev ${this.name} | awk '/inet /' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => null) || null;
    if (ip4s)
      ip4s = ip4s.split("\n").filter(l => l.length > 0).map(ip => ip.includes("/") ? ip : `${ip}/32`);
    return ip4s;
  }

  // use a dedicated carrier state for fast processing
  async carrierState() {
    const state = await this._getSysFSClassNetValue("carrier");
    return state;
  }

  async checkHttpStatus(defaultTestURL = "https://check.firewalla.com", defaultExpectedCode = 204) {
    if (!this.isWAN()) {
      this.log.error(`${this.name} is not a wan, checkHttpStatus is not supported`);
      return null;
    }

    if(this.isHttpTesting) {
      this.log.info("last round of http testing is not finished yet, this round is skipped.");
      return null;
    }

    this.isHttpTesting = true;

    const extraConf = this.networkConfig && this.networkConfig.extra;
    const testURL = (extraConf && extraConf.httpTestURL) || defaultTestURL;
    const expectedCode = (extraConf && extraConf.expectedCode) || defaultExpectedCode;
    const output = await exec(`curl -${testURL.startsWith("https") ? 'k' : ''}sq -m10 --interface ${this.name} -o /dev/null -w "%{http_code},%{redirect_url}" ${testURL}`).then(output => output.stdout.trim()).catch((err) => {
      this.log.error(`Failed to check http status on ${this.name} from ${testURL}`, err.message);
      return null;
    });

    this.isHttpTesting = false;

    if (!output)
      return null;
    const [statusCode, redirectURL] = output.split(',', 2);

    const result = {
      testURL,
      statusCode: !isNaN(statusCode) ? Number(statusCode) : statusCode,
      redirectURL: redirectURL,
      expectedCode: !isNaN(expectedCode) ? Number(expectedCode) : expectedCode,
      ts: Math.floor(new Date() / 1000)
    };

    if(this._wanStatus) {
      this._wanStatus.http = result;
    }

    return result;
  }

  getWanStatus() {
    return this._wanStatus;
  }

  async checkWanConnectivity(defaultPingTestIP = ["1.1.1.1", "8.8.8.8", "9.9.9.9"], defaultPingTestCount = 8, defaultPingSuccessRate = 0.5, defaultDnsTestDomain = "github.com", forceExtraConf = {}) {
    if (!this.isWAN()) {
      this.log.error(`${this.name} is not a wan, checkWanConnectivity is not supported`);
      return null;
    }
    const failures = [];
    let active = true;
    let carrierResult = null;
    let pingResult = null;
    let dnsResult = false; // avoid sending null to app/web
    const extraConf = Object.assign({}, this.networkConfig && this.networkConfig.extra, forceExtraConf);
    let pingTestIP = (extraConf && extraConf.pingTestIP) || defaultPingTestIP;
    let pingTestCount = (extraConf && extraConf.pingTestCount) || defaultPingTestCount;
    let pingTestTimeout = (extraConf && extraConf.pingTestTimeout) || 3;
    const pingTestEnabled = extraConf && extraConf.hasOwnProperty("pingTestEnabled") ? extraConf.pingTestEnabled : true;
    const dnsTestEnabled = extraConf && extraConf.hasOwnProperty("dnsTestEnabled") ? extraConf.dnsTestEnabled : true;
    const wanName = this.networkConfig && this.networkConfig.meta && this.networkConfig.meta.name;
    const wanUUID = this.networkConfig && this.networkConfig.meta && this.networkConfig.meta.uuid;
    if (_.isString(pingTestIP))
      pingTestIP = [pingTestIP];
    if (pingTestIP.length > 3) {
      this.log.warn(`Number of ping test target is greater than 3 on ${this.name}, will only use the first 3 for testing`);
      pingTestIP = pingTestIP.slice(0, 3);
    }
    const pingSuccessRate = (extraConf && extraConf.pingSuccessRate) || defaultPingSuccessRate;
    const dnsTestDomain = (extraConf && extraConf.dnsTestDomain) || defaultDnsTestDomain;
    const forceState = (extraConf && extraConf.forceState) || undefined;

    const carrierState = await this.carrierState();
    if (carrierState !== "1") {
      this.log.warn(`Carrier is not connected on interface ${this.name}, directly mark as non-active`);
      active = false;
      carrierResult = false;
      failures.push({type: "carrier"});
    } else
      carrierResult = true;

    if (active && pingTestEnabled) {
      await Promise.all(pingTestIP.map(async (ip) => {
        let cmd = `ping -n -q -I ${this.name} -c ${pingTestCount} -W ${pingTestTimeout} -i 1 ${ip} | grep "received" | awk '{print $4}'`;
        return exec(cmd).then((result) => {
          if (!result || !result.stdout || Number(result.stdout.trim()) < pingTestCount * pingSuccessRate) {
            this.log.warn(`Failed to pass ping test to ${ip} on ${this.name}`);
            failures.push({type: "ping", target: ip});
            era.addStateEvent(EventConstants.EVENT_PING_STATE, this.name+"-"+ip, 1, {
              "wan_test_ip":ip,
              "wan_intf_name":wanName,
              "wan_intf_uuid":wanUUID,
              "ping_test_count":pingTestCount,
              "success_rate": (result && result.stdout) ? Number(result.stdout.trim())/pingTestCount : 0,
            });
            return false;
          } else
            era.addStateEvent(EventConstants.EVENT_PING_STATE, this.name+"-"+ip, 0, {
              "wan_test_ip":ip,
              "wan_intf_name":wanName,
              "wan_intf_uuid":wanUUID,
              "ping_test_count":pingTestCount,
              "success_rate":Number(result.stdout.trim())/pingTestCount
            });
          return true;
        }).catch((err) => {
          this.log.error(`Failed to do ping test to ${ip} on ${this.name}`, err.message);
          failures.push({type: "ping", target: ip});
          return false;
        });
      })).then(results => {
        if (!results.some(result => result === true)) {
          this.log.error(`Ping test failed to all ping test targets on ${this.name}`);
          pingResult = false;
          active = false;
        } else
          pingResult = true;
      });
    }

    if (active && dnsTestEnabled) {
      const nameservers = await this.getDNSNameservers();
      const ip4s = await this.getIPv4Addresses();
      if (_.isArray(nameservers) && nameservers.length !== 0 && _.isArray(ip4s) && ip4s.length !== 0) {
        const srcIP = ip4s[0].split('/')[0];
        await Promise.all(nameservers.map(async (nameserver) => {
          const cmd = `dig -4 -b ${srcIP} +short +time=3 +tries=2 @${nameserver} ${dnsTestDomain}`;
          const result = await exec(cmd).then((result) => {
            if (!result || !result.stdout || result.stdout.trim().length === 0)  {
              this.log.warn(`Failed to resolve ${dnsTestDomain} using ${nameserver} on ${this.name}`);
              failures.push({type: "dns", target: nameserver, domain: dnsTestDomain});
              return false;
            } else {
              return true;
            }
          }).catch((err) => {
            this.log.error(`Failed to do DNS test using ${nameserver} on ${this.name}`, err.message);
            failures.push({type: "dns", target: nameserver, domain: dnsTestDomain});
            return false;
          });
          era.addStateEvent(EventConstants.EVENT_DNS_STATE, nameserver, result ? 0 : 1, {
            "wan_intf_name":wanName,
            "wan_intf_uuid":wanUUID,
            "name_server":nameserver,
            "dns_test_domain":dnsTestDomain
          });
          return result;
        })).then(results => {
          if (!results.some(result => result === true)) {
            this.log.error(`DNS test failed on all nameservers on ${this.name}`);
            dnsResult = false;
            active = false;
          } else
            dnsResult = true;
        });
      }
    }

    const result = {
      active: active, 
      forceState: carrierResult === true ? forceState : false, // do not honor forceState if carrier is not detected at all
      carrier: carrierResult,
      ping: pingResult,
      dns: dnsResult,
      failures: failures,
      ts: Math.floor(new Date() / 1000)
    };

    if(!active) {
      result.recentDownTime = result.ts; // record the recent down time
    }

    if(this._wanStatus) {
      this._wanStatus = Object.assign(this._wanStatus, result);
    }

    return result;
  }

  async state() {
    let [mac, mtu, carrier, duplex, speed, operstate, txBytes, rxBytes, rtid, ip4, ip4s, ip6, gateway, gateway6, dns] = await Promise.all([
      this._getSysFSClassNetValue("address"),
      this._getSysFSClassNetValue("mtu"),
      this._getSysFSClassNetValue("carrier"),
      this._getSysFSClassNetValue("duplex"),
      this._getSysFSClassNetValue("speed"),
      this._getSysFSClassNetValue("operstate"),
      this._getSysFSClassNetValue("statistics/tx_bytes"),
      this._getSysFSClassNetValue("statistics/rx_bytes"),
      routing.createCustomizedRoutingTable(`${this.name}_default`),
      exec(`ip addr show dev ${this.name} | awk '/inet /' | awk '$NF=="${this.name}" {print $2}' | head -n 1`, {encoding: "utf8"}).then((result) => result.stdout.trim() || null).catch((err) => null),
      this.getIPv4Addresses(),
      exec(`ip addr show dev ${this.name} | awk '/inet6 /' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout.trim() || null).catch((err) => null),
      routing.getInterfaceGWIP(this.name) || null,
      routing.getInterfaceGWIP(this.name, 6) || null,
      this.getDNSNameservers()
    ]);
    if (ip4 && ip4.length > 0 && !ip4.includes("/"))
      ip4 = `${ip4}/32`;
    if (ip6)
      ip6 = ip6.split("\n").filter(l => l.length > 0);
    let wanConnState = null;
    let wanTestResult = null;
    if (this.isWAN()) {
      wanConnState = this._getWANConnState(this.name) || {};
      wanTestResult = this._wanStatus; // use a different name to differentiate from existing wanConnState
    }
    return {mac, mtu, carrier, duplex, speed, operstate, txBytes, rxBytes, ip4, ip4s, ip6, gateway, gateway6, dns, rtid, wanConnState, wanTestResult};
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
          // reapply all plugins on the dependency chain if either IPv4 or IPv6 is static IP. 
          // otherwise, only reapply the WAN interface plugin itself. Downstream plugins, e.g., routing, will be triggered by events, e.g., IP_CHANGE from dhclient
          if (this.isStaticIP())
            this.propagateConfigChanged(true);
          pl.scheduleReapply();
        }
        break;
      }
      case event.EVENT_IF_PRESENT:
      case event.EVENT_IF_DISAPPEAR: {
        if (this.networkConfig && this.networkConfig.allowHotplug === true) {
          this._reapplyNeeded = true;
          // trigger downstream plugins to reapply config
          this.propagateConfigChanged(true);
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
          this.markOutputConnection().catch((err) => {
            this.log.error(`Failed to add outgoing mark on ${this.name}`, err.message);
          })
        }
      }
      default:
    }
  }
}

module.exports = InterfaceBasePlugin;
