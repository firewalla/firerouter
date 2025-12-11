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
const url = require('url');
const { v4: uuidv4 } = require("uuid");

const r = require('../../util/firerouter');

const exec = require('child-process-promise').exec;

const fs = require('fs');
const Promise = require('bluebird');
const {Address4, Address6} = require('ip-address');
const uuid = require('uuid');
const ip = require('ip');
const AsyncLock = require('async-lock');
const LOCK_PD_CALC = "LOCK_PD_CALC";
const lock = new AsyncLock();

const Message = require('../../core/Message.js');
const wrapIptables = require('../../util/util.js').wrapIptables;

const event = require('../../core/event.js');
const era = require('../../event/EventRequestApi.js');
const EventConstants = require('../../event/EventConstants.js');
const pclient = require('../../util/redis_manager.js').getPublishClient();
const rclient = require('../../util/redis_manager.js').getPrimaryDBRedisClient();
const validator = require('validator');

Promise.promisifyAll(fs);

const routing = require('../../util/routing.js');
const util = require('../../util/util.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();

const DHCP_RESTART_INTERVAL = 4;
const ON_OFF_THRESHOLD = 2;
const OFF_ON_THRESHOLD = 5;
const DUID_RECORD_MAX = 10;

class InterfaceBasePlugin extends Plugin {

  async isInterfacePresent() {
    return fs.accessAsync(r.getInterfaceSysFSDirectory(this.name), fs.constants.F_OK).then(() => true).catch((err) => false);
  }

  async flushIP(af = null) {
    if (!af || af == 4) {
      await exec(`sudo ip -4 addr flush dev ${this.name}`).catch((err) => {
        this.log.error(`Failed to flush ip address of ${this.name}`, err);
      });
      // make sure to stop dhclient no matter if dhcp is enabled
      if (this.networkConfig.dhcp) {
        await exec(`sudo systemctl stop firerouter_dhclient@${this.name}`).catch((err) => {});
      }
    }
    if (!af || af == 6) {
      // make sure to stop dhcpv6 client no matter if dhcp6 is enabled
      if (this.networkConfig.dhcp6) {
        await exec(`sudo systemctl stop firerouter_dhcpcd6@${this.name}`).catch((err) => {});
      }
      if (this.isWAN() || this.isLAN()) {
        await exec(`sudo ip -6 addr flush dev ${this.name}`).catch((err) => {});
        // remove dhcpcd lease file to ensure it will trigger PD_CHANGE event when it is re-applied
        const lease6Filename = await this._getDHCPCDLease6Filename();
        if (lease6Filename)
          await exec(`sudo rm -f ${lease6Filename}`).catch((err) => {});
  
        await exec(`sudo rm -f ${this._getDeprecatedDhcpcdFilePath()}`).catch((err) => { }); // remove deprecated dhcpcd file
        await exec(`sudo rm -f ${this._getDhcpcdFilePath()}`).catch((err) => { });
        await exec(`sudo rm -f ${this._getDhcpcdRaFilePath()}`).catch((err) => { });
      }
      // regenerate ipv6 link local address based on EUI64
      await exec(`sudo sysctl -w net.ipv6.conf.${this.getEscapedNameForSysctl()}.addr_gen_mode=0`).catch((err) => {});
      await exec(`sudo sysctl -w net.ipv6.conf.${this.getEscapedNameForSysctl()}.disable_ipv6=1`).catch((err) => {});
      await exec(`sudo sysctl -w net.ipv6.conf.${this.getEscapedNameForSysctl()}.disable_ipv6=0`).catch((err) => {});
    }
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

      // remove cached router-advertisement ipv6 address file
      if (this.networkConfig.dhcp6) {
        await exec(`sudo rm /dev/shm/dhcpcd.*.${this.name}`).catch((err) => {});
      }
        
      if (this.isWAN() || this.isLAN()) {
        // flush related routing tables
        await routing.flushRoutingTable(`${this.name}_local`).catch((err) => {});
        await routing.flushRoutingTable(`${this.name}_default`).catch((err) => {});

        // remove related policy routing rules
        await routing.removeInterfaceRoutingRules(this.name).catch((err) => {});
        await routing.removeInterfaceGlobalRoutingRules(this.name).catch((err) => {});
        if (this.isLAN())
          await routing.removeInterfaceGlobalLocalRoutingRules(this.name).catch((err) => {});
      }

      if (this.isWAN()) {
        // considered as WAN interface, remove access to "routable"
        await Promise.all([
          routing.removePolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE, 5001).catch((err) => {}),
          routing.removePolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE, 5001, null, 6).catch((err) => {}),
          // restore reverse path filtering settings
          exec(`sudo sysctl -w net.ipv4.conf.${this.getEscapedNameForSysctl()}.rp_filter=1`).catch((err) => {})
        ]);
        // remove fwmark defautl route ip rule
        const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
        await Promise.all([
          routing.removePolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/${routing.MASK_REG}`).catch((err) => {}),
          routing.removePolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/${routing.MASK_REG}`, 6).catch((err) => {}),
          routing.removePolicyRoutingRule("all", "lo", `${this.name}_local`, 499, `${rtid}/${routing.MASK_REG}`).catch((err) => {}),
          routing.removePolicyRoutingRule("all", "lo", `${this.name}_local`, 499, `${rtid}/${routing.MASK_REG}`, 6).catch((err) => {}),
          exec(wrapIptables(`sudo iptables -w -t nat -D FR_PREROUTING -i ${this.name} -m connmark --mark 0x0/${routing.MASK_ALL} -j CONNMARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
            this.log.error(`Failed to add inbound connmark rule for WAN interface ${this.name}`, err.message);
          }),
          exec(wrapIptables(`sudo ip6tables -w -t nat -D FR_PREROUTING -i ${this.name} -m connmark --mark 0x0/${routing.MASK_ALL} -j CONNMARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
            this.log.error(`Failed to add ipv6 inbound connmark rule for WAN interface ${this.name}`, err.message);
          }),
          this.unmarkOutputConnection(rtid).catch((err) => {
            this.log.error(`Failed to remove outgoing mark for WAN interface ${this.name}`, err.message);
          })
        ]);
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
      if (this.isWAN() || this.isLAN()) {
        await Promise.all([
          routing.removePolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE, 5002).catch((err) => { }),
          routing.removePolicyRoutingRule("all", this.name, routing.RT_LAN_ROUTABLE, 5002, null, 6).catch((err) => { }),
        ]);
      }
    }

    // This is a special logic that hwAddr will NOT be reset to factory during FLUSH
    // because it may cause endless loop
    // if (this.networkConfig.hwAddr) {
    //   await this.resetHardwareAddress();
    // }
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


  _getDeprecatedDhcpcdFilePath() {
    return `/run/resolvconf/interface/${this.name}.dhcpcd`;
  }

  _getDhcpcdFilePath() {
    return `/run/resolvconf/interface/${this.name}.dhcpcd.v6`;
  }

  _getDhcpcdRaFilePath() {
    return `/run/resolvconf/interface/${this.name}.dhcpcd.ra`;
  }

  async _getDHCPCDLease6Filename() {
    let dhcpcdBinPath = platform.getBinaryPath() + '/dhcpcd';
    // this.log.debug(`checking if dhcpcd binary exists: ${dhcpcdBinPath}`);
    if (!await fs.accessAsync(dhcpcdBinPath, fs.constants.F_OK).then(() => true).catch((err) => false)) {
      dhcpcdBinPath = 'dhcpcd';
    }
    const version = await exec(`${dhcpcdBinPath} --version | head -n 1 | awk '{print $2}'`).then(result => result.stdout.trim()).catch((err) => {
      this.log.error(`Failed to get dhcpcd version`, err.message);
      return null;
    });
    if (version) {
      if (version.startsWith("6."))
        return `/var/lib/dhcpcd5/dhcpcd-${this.name}.lease6`;
      if (version.startsWith("7."))
        return `/var/lib/dhcpcd/${this.name}.lease6`;
    }
    return null;
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
      await routing.createInterfaceRoutingRules(this.name, this.networkConfig.noSelfRoute);
      await routing.createInterfaceGlobalRoutingRules(this.name);
      if (this.isLAN())
        await routing.createInterfaceGlobalLocalRoutingRules(this.name);
    }

    if (this.isWAN()) {
      // loosen reverse path filtering settings, this is necessary for dual WAN
      await exec(`sudo sysctl -w net.ipv4.conf.${this.getEscapedNameForSysctl()}.rp_filter=2`).catch((err) => {});
      // create fwmark default route ip rule for WAN interface. Application should add this fwmark to packets to implement customized default route
      const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
      await Promise.all(
        [
          routing.createPolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/${routing.MASK_REG}`),
          routing.createPolicyRoutingRule("all", null, `${this.name}_default`, 6001, `${rtid}/${routing.MASK_REG}`, 6),
          routing.createPolicyRoutingRule("all", "lo", `${this.name}_local`, 499, `${rtid}/${routing.MASK_REG}`),
          routing.createPolicyRoutingRule("all", "lo", `${this.name}_local`, 499, `${rtid}/${routing.MASK_REG}`, 6),
          exec(wrapIptables(`sudo iptables -w -t nat -A FR_PREROUTING -i ${this.name} -m connmark --mark 0x0/${routing.MASK_ALL} -j CONNMARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => { // do not reset connmark if it is already set in mangle table
            this.log.error(`Failed to add inbound connmark rule for WAN interface ${this.name}`, err.message);
          }),
          exec(wrapIptables(`sudo ip6tables -w -t nat -A FR_PREROUTING -i ${this.name} -m connmark --mark 0x0/${routing.MASK_ALL} -j CONNMARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
            this.log.error(`Failed to add ipv6 inbound connmark rule for WAN interface ${this.name}`, err.message);
          })
        ]
      );
    }
  }

  _getDHCPCD6ConfigPath() {
    return `${r.getUserConfigFolder()}/dhcpcd6/${this.name}.conf`;
  }

  isIPv6Enabled() {
    return this.networkConfig.dhcp6 || // DHCP
      this.networkConfig.ipv6 && (_.isString(this.networkConfig.ipv6) || _.isArray(this.networkConfig.ipv6)) || // Static
      this.networkConfig.ipv6DelegateFrom; // Delegate
  }

  getEscapedNameForSysctl() {
    return this.name.replace(/\./gi, "/");
  }

  async applyIpv6Settings() {
    const disabled = this.isIPv6Enabled() ? 0 : 1;
    await exec(`sudo sysctl -w net.ipv6.conf.${this.getEscapedNameForSysctl()}.disable_ipv6=${disabled}`)
      .catch((err) => {
        this.log.error("Failed to set accept_ra, err", err)
      });

    if(disabled) {
      return;
    }

    if (this.networkConfig.dhcp6) {
      // add link local route to interface local and default routing table
      await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_local`, null, 6).catch((err) => {});
      await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_default`, null, 6).catch((err) => {});
      const pdSize = this.networkConfig.dhcp6.pdSize || null;
      if (pdSize && pdSize > 64)
        this.fatal(`Prefix delegation size should be no more than 64 on ${this.name}, ${pdSize}`);
      let content = await fs.readFileAsync(`${r.getFireRouterHome()}/etc/dhcpcd.conf.template`, {encoding: "utf8"});
      const numOfPDs = this.networkConfig.dhcp6.numOfPDs || 1;
      const pdHints = this.networkConfig.dhcp6.pdHints || [];
      const rapidCommitOpts = this.networkConfig.dhcp6.rapidCommit === false ? "#option rapid_commit" : "option rapid_commit";
      const ianaOpts = this.networkConfig.dhcp6.iana === false ? "" : "ia_na"; // by default ia_na will be specified unless explicitly disabled
      const pdOpts = [];
      for (let i = 1; i <= numOfPDs; i++) {
        if (i <= pdHints.length)
          pdOpts.push(`ia_pd ${i}/${pdHints[i - 1]} not_exist/1`);
        else
          pdOpts.push(`ia_pd ${i}${pdSize ? `/::/${pdSize}` : ""} not_exist/1`);
      }
      content = content.replace(/%RAPID_COMMIT_OPTS%/g, rapidCommitOpts);
      content = content.replace(/%IA_NA_OPTS%/g, ianaOpts);
      content = content.replace(/%IA_PD_OPTS%/g, pdOpts.join('\n'));
      await fs.writeFileAsync(this._getDHCPCD6ConfigPath(), content);
      // customize duid type
      if (this.networkConfig.dhcp6.duidType) {
        await this._genDuid(this.networkConfig.dhcp6.duidType);
      } else {
        await this._resetDuid();
      }
      // start dhcpcd for SLAAC and stateful DHCPv6 if necessary
      await exec(`sudo systemctl restart firerouter_dhcpcd6@${this.name}`).catch((err) => {
        this.fatal(`Failed to enable dhcpv6 client on interface ${this.name}: ${err.message}`);
      });
    } else {
      if (this.networkConfig.ipv6 && (_.isString(this.networkConfig.ipv6) || _.isArray(this.networkConfig.ipv6))) {
        // add link local route to interface local and default routing table
        await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_local`, null, 6).catch((err) => {});
        await routing.addRouteToTable("fe80::/64", null, this.name, `${this.name}_default`, null, 6).catch((err) => {});
        const ipv6Addrs = _.isString(this.networkConfig.ipv6) ? [this.networkConfig.ipv6] : this.networkConfig.ipv6;
        for (const addr6 of ipv6Addrs) {
          await exec(`sudo ip -6 addr add ${addr6} dev ${this.name}`).catch((err) => {
            this.log.error(`Failed to set ipv6 addr ${addr6} for interface ${this.name}`, err.message);
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
          await lock.acquire(LOCK_PD_CALC, async () => {
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
              }
            }
          });
        }
      }
      // TODO: do not support static dns nameservers for IPv6 currently
    }
  }

  // just for readability
  _formatDuid(segment) {
    return segment.replace(/-/g,"").match(/.{1,2}/g).join(":")
  }

  _getDHClientConfigPath() {
    return `${r.getUserConfigFolder()}/dhclient/${this.name}.conf`;
  }

  _getDuidType(duid) {
    const prefix = duid.slice(0,5);
    let duidType = '';
    switch (prefix) {
      case '00:01':
        duidType = 'DUID-LLT';
        break;
      case '00:02':
        duidType = 'DUID-EN';
        break;
      case '00:03':
        duidType = 'DUID-LL';
        break;
      case '00:04':
        duidType = 'DUID-UUID';
        break;
      default:
        break;
    }
    return duidType;
  }

  async _getDuid() {
    return await fs.readFileAsync(`${r.getRuntimeFolder()}/dhcpcd-${this.name}.duid`, {encoding: 'utf8'}).then(content => content.trim()).catch((err) => {
      this.log.info(`Cannot read current DUID ${r.getRuntimeFolder()}/dhcpcd-${this.name}.duid`, err.message);
    });
  }

  async _resetDuid() {
    this.log.debug("Resetting DUID");
    let duidType = 'DUID-UUID';
    const arch = await exec("uname -m", {encoding: 'utf8'}).then(result => result.stdout.trim()).catch((err) => {
      this.log.error(`Failed to get architecture`, err.message);
      return null;
    });
    if (arch) {
      switch (arch) {
        case 'x86_64':
          break;
        case 'aarch64':
          duidType = 'DUID-LLT';
          break;
        default:
          break;
      }
    }
    return await this._genDuid(duidType);
  }

  // Generate DHCP Unique Identifier (DUID), see RFC8415
  async _genDuid(duidType, force=false) {
    this.log.debug("Generating DUID", this.name, duidType);
    let origDuid = await this._getDuid();
    if (origDuid && origDuid.length > 5) {
      this.log.debug("Found current DUID", origDuid);
      const origDuidType = this._getDuidType(origDuid);
      if (origDuidType == duidType && !force) {
        this.log.info(`${this.name} duid already generated as`, origDuid);
        return;
      }
    }
    let duid, ethMac;
    switch (duidType) {
      case 'DUID-LLT':
        // 00:01 DUID-Type (DUID-LLT), 00:01 hardware type (Ethernet)
        ethMac = await this.getLinkAddress();
        if (ethMac) {
          const ts = this._formatDuid(Math.floor(Date.now()/1000).toString(16));
          duid = `00:01:00:01:${ts}:${ethMac}`;
        } else {
          this.log.warn("cannot generate duid of type DUID-LLT, no ethernet address");
        }
        break;
      case 'DUID-EN':
        // TODO 00:02 DUID-Type (DUID-EN)
        break;
      case 'DUID-LL':
        // 00:03 DUID-Type (DUID-LL), 00:01 hardware type (Ethernet)
        ethMac = await this.getLinkAddress();
        if (ethMac) {
          duid = `00:03:00:01:${ethMac}`;
        } else {
          this.log.warn("cannot generate duid of type DUID-LL, no ethernet address");
        }
        break;
      case 'DUID-UUID':
        // 00:04 DUID-Type (DUID-UUID), DUID Based on UUID, see rfc6355
        const uuid = await this._genDuidUuid();
        if (uuid) {
          duid = '00:04:' + this._formatDuid(uuid);
        } else {
          this.log.warn("cannot generate duid of type DUID-UUID, no uuid");
        }
        break;
      default:
    }
    if (!duid) {
      this.log.warn("cannot generate duid of type", duidType);
      return;
    }
    // save previous duid in redis
    await this.saveDuidRecord(`${origDuid}#${duidType}:${duid}`);
    await exec(`echo ${duid} | sudo tee ${r.getRuntimeFolder()}/dhcpcd-${this.name}.duid`).catch((err) => {});
    this.log.info(`generate new duid for ${this.name}`, duid);
    return duid;
  }

  async _genDuidUuid() {
    const existUuid = await fs.readFileAsync(`${r.getRuntimeFolder()}/dhcpcd-${this.name}.duid_uuid`, {encoding: "utf8"}).then((content) => content.trim()).catch((err) => null);
    if (existUuid) {
      return existUuid;
    }

    const newUuid = uuidv4();
    await fs.writeFileAsync(`${r.getRuntimeFolder()}/dhcpcd-${this.name}.duid_uuid`, newUuid).catch((err) => {this.log.warn("fail to persistently save duid uuid", err.message)});
    return newUuid;
  }

  async saveDuidRecord(record){
    await rclient.zaddAsync(`duid_record_${this.name}`, Math.floor(new Date() / 1000), record);
    // keep latest records
    const count = await rclient.zcardAsync(`duid_record_${this.name}`);
    if (count > DUID_RECORD_MAX) {
      await rclient.zremrangebyrankAsync(`duid_record_${this.name}`, 0, count-DUID_RECORD_MAX-1);
    }
  }

  isStaticIP() {
    // either IPv4 or IPv6 is static
    if (this.networkConfig.ipv4 || (this.networkConfig.ipv4s && this.networkConfig.ipv4s.length > 0) || (this.networkConfig.ipv6 && this.networkConfig.ipv6.length > 0))
      return true;
    return false;
  }

  isDHCP() {
    if (this.networkConfig.dhcp || this.networkConfig.dhcp6)
      return true;
    return false;
  }

  _overrideNTPoverDHCP(dhclientConf){
    // replace with ntp options
    if (this.networkConfig.allowNTPviaDHCP === true){
      dhclientConf = dhclientConf.replace(/%NTP_SERVERS%/g, ", ntp-servers");
      dhclientConf = dhclientConf.replace(/%DHCP6_SNTP_SERVERS%/g, " dhcp6.sntp-servers,");
    } else {
      // replace with empty string
      dhclientConf = dhclientConf.replace(/%NTP_SERVERS%/g, "");
      dhclientConf = dhclientConf.replace(/%DHCP6_SNTP_SERVERS%/g, "");
    }
    return dhclientConf
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
      dhclientConf=this._overrideNTPoverDHCP(dhclientConf);
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
            this.log.error(`Failed to set ipv4 ${addr4} for interface ${this.name}: ${err.message}`);
          });
        }
      }
    }

    await this.applyIpv6Settings();
  }

  async applyDnsSettings() {
    if (this.isDHCP() || (this.networkConfig.nameservers && this.networkConfig.nameservers.length > 0) || (this.networkConfig.dns6Servers && this.networkConfig.dns6Servers.length > 0)) {
      await fs.accessAsync(r.getInterfaceResolvConfPath(this.name), fs.constants.F_OK).then(() => {
        this.log.info(`Remove old resolv conf for ${this.name}`);
        return fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name));
      }).catch((err) => {});
      // specified DNS nameservers supersedes those assigned by DHCP
      let dnsservers = [];
      if (this.networkConfig.nameservers && this.networkConfig.nameservers.length > 0 && this.networkConfig.nameservers.some(s => new Address4(s).isValid())) {
        dnsservers = this.networkConfig.nameservers.filter(s => new Address4(s).isValid());
      } else {
        dnsservers = await this.getOrigDNSNameservers();
      }

      if (this.networkConfig.dns6Servers && this.networkConfig.dns6Servers.some(s => new Address6(s).isValid())) {
        dnsservers = dnsservers.concat(this.networkConfig.dns6Servers.filter(s => new Address6(s).isValid()));
      } else {
        dnsservers = dnsservers.concat(await this.getOrigDNS6Nameservers());
      }
      if (dnsservers.length > 0) {
        let nameservers = dnsservers.map((nameserver) => `nameserver ${nameserver}`).join("\n") + "\n";
        await fs.writeFileAsync(r.getInterfaceResolvConfPath(this.name), nameservers);
      } else {
        const dns = await this.getOrigDNSNameservers();
        const dns6 = await this.getOrigDNS6Nameservers();
        dns.push(...dns6);
        const content = dns.map((nameserver) => `nameserver ${nameserver}`).join("\n") + "\n";
        await fs.writeFileAsync(r.getInterfaceResolvConfPath(this.name), content);
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
      await Promise.all([
        routing.createPolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE, 5001).catch((err) => {}),
        routing.createPolicyRoutingRule("all", this.name, routing.RT_WAN_ROUTABLE, 5001, null, 6).catch((err) => {}),
      ]);
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

  async resetConnmark() {
    // reset first bit of connmark to make packets of established connections go through iptables filter again
    await exec(`sudo conntrack -U -m 0x00000000/0x80000000`).catch((err) => {});
    await exec(`sudo conntrack -U -f ipv6 -m 0x00000000/0x80000000`).catch((err) => {});
  }

  async updateRouteForDNS() {
    await this._removeOldRouteForDNS();
    const dns = await this.getDNSNameservers();
    const gateway = await routing.getInterfaceGWIP(this.name, 4);
    const gateway6 = await routing.getInterfaceGWIP(this.name, 6);
    if (!_.isArray(dns) || dns.length === 0 || !gateway)
      return;
    for (const dnsIP of dns) {
      if (new Address4(dnsIP).isValid())
        await routing.addRouteToTable(dnsIP, gateway, this.name, `${this.name}_default`, null, 4, true)
                      .then(()=>{this._updateDnsRouteCache(dnsIP, gateway, this.name, `${this.name}_default`, 4);})
                      .catch((err) => {});
      else
        await routing.addRouteToTable(dnsIP, gateway6, this.name, `${this.name}_default`, null, 6, true)
                      .then(()=>{this._updateDnsRouteCache(dnsIP, gateway6, this.name, `${this.name}_default`, 6);})
                      .catch((err) => {});
    }
  }

  async _removeOldRouteForDNS() {
    // remove Old DNS specific routes
    if (_.isObject(this._dnsRoutes)) {
      for (const inf of Object.keys(this._dnsRoutes)) {
        for (const dnsRoute of this._dnsRoutes[inf]) {
          await routing.removeRouteFromTable(dnsRoute.dest, dnsRoute.gw, dnsRoute.viaIntf, dnsRoute.tableName ? dnsRoute.tableName :"main", dnsRoute.af).catch((err) => { });
        }
      }
    } 
    this._dnsRoutes = {}
  }

  _updateDnsRouteCache(dnsIP, gw, viaIntf, tableName="main", af=4) {
    if (!this._dnsRoutes){
      this._dnsRoutes = {}
    }
    if (!this._dnsRoutes[viaIntf]) {
      this._dnsRoutes[viaIntf] = [];
    }
    for (const dns of this._dnsRoutes[viaIntf]) {
      if (dns.dest == dnsIP && dns.gw == gw && dns.viaIntf == viaIntf && dns.tableName == tableName) {
        // ensure no duplicates
        return;
      }
    }
    this._dnsRoutes[viaIntf].push({dest: dnsIP, gw: gw, viaIntf: viaIntf, tableName: tableName, af:af});
  }

  
  async unmarkOutputConnection(rtid) {
    if (_.isArray(this._srcIPs)) {
      for (const ip4Addr of this._srcIPs) {
        await exec(wrapIptables(`sudo iptables -w -t mangle -D FR_OUTPUT -s ${ip4Addr} -m conntrack --ctdir ORIGINAL -m mark --mark 0x0/0xffff -j MARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
          this.log.error(`Failed to remove outgoing MARK rule for WAN interface ${this.name} ${ip4Addr}`, err.message);
        });
      }
    }
    this._srcIPs = [];
  }

  async markOutputConnection() {
    if (!this.isWAN())
      return;
    const ip4s = await this.getIPv4Addresses();
    const rtid = await routing.createCustomizedRoutingTable(`${this.name}_default`);
    if (ip4s && rtid) {
      if (!_.isEmpty(this._srcIPs))
        await this.unmarkOutputConnection(rtid);
      const srcIPs = [];
      for (const ip4 of ip4s) {
        const ip4Addr = ip4.split('/')[0];
        await exec(wrapIptables(`sudo iptables -w -t mangle -A FR_OUTPUT -s ${ip4Addr} -m conntrack --ctdir ORIGINAL -m mark --mark 0x0/0xffff -j MARK --set-xmark ${rtid}/${routing.MASK_ALL}`)).catch((err) => {
          this.log.error(`Failed to add outgoing MARK rule for WAN interface ${this.name} ${ip4Addr}`, err.message);
        });
        srcIPs.push(ip4Addr);
      }
      this._srcIPs = srcIPs;
    }
  }

  hasHardwareAddress() {
    return true;
  }

  async setHardwareAddress() {
    if (!this.hasHardwareAddress())
      return;
    if(!this.networkConfig.enabled) {
      await this.resetHardwareAddress();
      return;
    }

    if(!this.networkConfig.hwAddr) {
      await this.resetHardwareAddress();
      return;
    }

    this.log.info(`Setting hwaddr of iface ${this.name} to`, this.networkConfig.hwAddr);
    await platform.setHardwareAddress(this.name, this.networkConfig.hwAddr);
  }

  async resetHardwareAddress() {
    if (!this.hasHardwareAddress())
      return;
    await platform.resetHardwareAddress(this.name, this.networkConfig);
  }

  getDefaultMTU() {
    return null;
  }

  async getMTU() {
    return fs.readFileAsync(`/sys/class/net/${this.name}/mtu`, {encoding: "utf8"}).then(result => Number(result.trim())).catch((err) => {
      this.log.error(`Failed to get MTU of ${this.name}`, err.message);
      return null;
    });
  }

  async setMTU() {
    const mtu = this.networkConfig.mtu || this.getDefaultMTU();
    const currentMTU = await this.getMTU();
    if (mtu && mtu !== currentMTU)
      await platform.setMTU(this.name, mtu);
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

    if (this.networkConfig.allowHotplug === true && platform.isHotplugSupported(this.name)) {
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

    await this.setMTU();

    await this.applyIpSettings();

    await this.applyDnsSettings();

    await this.changeRoutingTables();

    await this.resetConnmark();

    if (this.isWAN()) {
      this._wanStatus = {};
      this._wanConnState = this._wanConnState || { ready: true, successCount: OFF_ON_THRESHOLD - 1, failureCount: 0 };
      // the next wan conn check event will determine the 'ready' state
      this._wanConnState.successCount = OFF_ON_THRESHOLD - 1;
      this._wanConnState.failureCount = ON_OFF_THRESHOLD - 1;

      this.setPendingTest(true);

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

  getWANConnState() {
    const result = _.pick(Object.assign({}, this._wanConnState), "ready");
    result.pendingTest = this._pendingTest || false;
    result.active = false;
    const routingPlugin = pl.getPluginInstance("routing", "global");
    if (routingPlugin) {
      const state = routingPlugin.getWANConnState(this.name);
      if (state)
        result.active = state.active || false;
    }
    return result;
  }

  async getDNSNameservers() {
    const dns = await fs.readFileAsync(r.getInterfaceResolvConfPath(this.name), {encoding: "utf8"}).then(content => content.trim().split("\n").filter(line => line.startsWith("nameserver")).map(line => line.replace("nameserver", "").trim())).catch((err) => null);
    return dns;
  }

  async getOrigDNSNameservers() {
    const dns = await fs.readFileAsync(this._getResolvConfFilePath(), {encoding: "utf8"}).then(content => content.trim().split("\n").filter(line => line.startsWith("nameserver")).map(line => line.replace("nameserver", "").trim())).catch((err) => null);
    return dns || [];
  }

  async getDns4Nameservers() {
    const dns = await this.getDNSNameservers() || [];
    return dns.filter(i => new Address4(i).isValid());
  }

  async getDns6Nameservers() {
    if (!this.isIPv6Enabled()) return [];
    const dns = await this.getDNSNameservers() || [];
    return dns.filter(i => new Address6(i).isValid());
  }

  async getOrigDNS6Nameservers() {
    if (!this.isIPv6Enabled()) return [];
    const dns6 = await fs.readFileAsync(this._getDhcpcdFilePath(), { encoding: "utf8" }).then(content => content.trim().split("\n").filter(line => line.startsWith("nameserver")).map(line => line.replace("nameserver", "").trim())).catch((err) => []) || [];
    const dns6Ra = await fs.readFileAsync(this._getDhcpcdRaFilePath(), { encoding: "utf8" }).then(content => content.trim().split("\n").filter(line => line.startsWith("nameserver")).map(line => line.replace("nameserver", "").trim())).catch((err) => []) || [];
    return _.uniq([...dns6, ...dns6Ra]) || [];
  }

  async getPrefixDelegations() {
    const pds = await fs.readFileAsync(r.getInterfaceDelegatedPrefixPath(this.name), {encoding: "utf8"}).then(content => content.trim().split("\n").filter(line => line.length > 0)).catch((err) => null);
    return pds;
  }

  async getRoutableSubnets() {
    return null;
  }

  async getIPv4Addresses() {
    if (!this.networkConfig.enabled)
      return null;
    // if there is static ipv4 config, directly return it to reduce overhead of invoking ip command
    const staticIpv4s = {};
    if (_.isArray(this.networkConfig.ipv4s) && !_.isEmpty(this.networkConfig.ipv4s))
      for (const ip4 of this.networkConfig.ipv4s)
        staticIpv4s[ip4] = 1;
    if (_.isString(this.networkConfig.ipv4))
      staticIpv4s[this.networkConfig.ipv4] = 1;
    if (!_.isEmpty(staticIpv4s))
      return Object.keys(staticIpv4s);
    let ip4s = await exec(`ip addr show dev ${this.name} | awk '/inet /' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => null) || null;
    if (ip4s)
      ip4s = ip4s.split("\n").filter(l => l.length > 0).map(ip => ip.includes("/") ? ip : `${ip}/32`);
    return ip4s;
  }

  async getIPv6Addresses() {
    if (!this.networkConfig.enabled)
      return null;
    // there may be link-local ipv6 on interface, which is not available in static ipv6 config, always try to get ipv6 addresses from ip addr output
    let ip6s = await exec(`ip addr show dev ${this.name} | awk '/inet6 /' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout.trim() || null).catch((err) => null);
    if (ip6s)
      ip6s = ip6s.split("\n").filter(l => l.length > 0);
    return ip6s;
  }

  async getRoutableIPv6Addresses() {
    const ip6s = await this.getIPv6Addresses();
    if(_.isEmpty(ip6s)) {
      return ip6s;
    }

    return ip6s.filter((ip6) => !ip.isPrivate(ip6));
  }

  async getHardwareAddress() {
    const addr = await exec(`cat /sys/class/net/${this.name}/address`).then((result) => result.stdout.trim() || null).catch((err) => null);
    return addr;
  }

  async getLinkAddress() {
    const addr = await exec(`cat /sys/class/net/${this.name}/address`).then((result) => result.stdout.trim() || null).catch((err) => {
      this.log.error(`Failed to get hardware address of ${this.name}`, err.message);
    });
    return addr;
  }

  async gatewayReachable() {
    const gw = await routing.getInterfaceGWIP(this.name);
    if (!gw)
      return false;
    if (!this.hasHardwareAddress())
      return false;
    const lines = await fs.readFileAsync("/proc/net/arp", {encoding: "utf8"}).then((data) => data.trim().split("\n")).catch((err) => {return [];});
    for (const line of lines) {
      const [ ip, /* type */, flags, mac, /* mask */, intf ] = line.replace(/ [ ]*/g, ' ').split(' ');
      if (ip === gw && intf === this.name && flags === "0x2" && mac !== "00:00:00:00:00:00")
        return true;
    }
    return false;
  }

  // use a dedicated carrier state for fast processing
  async carrierState() {
    const state = await this._getSysFSClassNetValue("carrier");
    return state;
  }

  async operstateState() {
    const state = await this._getSysFSClassNetValue("operstate");
    return state;
  }

  async linkSpeed() {
    const speed = Number(await this._getSysFSClassNetValue("speed"));
    return !isNaN(speed) ? speed : 0;
  }

  // is the interface physically ready to connect
  async readyToConnect() {
    const carrierState = await this.carrierState();
    return carrierState === "1";
  }

  async checkHttpStatus(defaultTestURL = "https://check.firewalla.com", defaultExpectedCode = 204, expectedContent = null) {
    if (!this.isWAN()) {
      this.log.error(`${this.name} is not a wan, checkHttpStatus is not supported`);
      return null;
    }

    this.isHttpTesting = this.isHttpTesting || {};

    if(this.isHttpTesting[defaultTestURL]) {
      this.log.info("last round of http testing is not finished yet, this round is skipped.");
      return null;
    }

    const u = url.parse(defaultTestURL);
    const hostname = u.hostname;
    const protocol = u.protocol;
    const port = u.port || protocol === "http:" && 80 || protocol === "https:" && 443;

    if(!hostname || !port) {
      this.log.error("invalid test url:", defaultTestURL);
      return null;
    }

    this.isHttpTesting[defaultTestURL] = true;

    const dnsResult = await this.getDNSResult(u.hostname).catch((err) => false);
    if(!dnsResult) {
      this.log.error("failed to resolve dns on domain", u.hostname, 'on', this.name);
      delete this.isHttpTesting[defaultTestURL];
      return null;
    }

    const extraConf = this.networkConfig && this.networkConfig.extra;
    const testURL = (extraConf && extraConf.httpTestURL) || defaultTestURL;
    const expectedCode = (extraConf && extraConf.expectedCode) || defaultExpectedCode;
    let contentFile = "/dev/null";
    if (expectedContent) {
      contentFile = `/dev/shm/${uuid.v4()}`;
    }
    const cmd = `timeout 3 curl -${testURL.startsWith("https") ? 'k' : ''}sq -m6 --resolve ${hostname}:${port}:${dnsResult} --interface ${this.name} -o ${contentFile} -w "%{http_code},%{redirect_url}" ${testURL}`;
    const output = await exec(cmd).then(output => output.stdout.trim()).catch((err) => {
      this.log.error(`Failed to check http status on ${this.name} from ${testURL}`, err.message);
      return null;
    });

    delete this.isHttpTesting[defaultTestURL];

    if (!output) {
      if (contentFile !== "/dev/null")
        await fs.unlinkAsync(contentFile).catch((err) => {});
      return null;
    }
    const [statusCode, redirectURL] = output.split(',', 2);

    const result = {
      testURL,
      statusCode: !isNaN(statusCode) ? Number(statusCode) : statusCode,
      redirectURL: redirectURL,
      expectedCode: !isNaN(expectedCode) ? Number(expectedCode) : expectedCode,
      ts: Math.floor(new Date() / 1000)
    };

    if (expectedContent && contentFile !== "/dev/null") {
      const content = await fs.readFileAsync(contentFile, { encoding: "utf8"}).catch((err) => null);
      result.contentMismatch = (content !== expectedContent);
      if (result.contentMismatch && !result.redirectURL) { // HTTP request is redirected without using HTTP redirect, maybe from IP layer redirection
        result.statusCode = 302;
        result.redirectURL = testURL;
      }
      await fs.unlinkAsync(contentFile).catch((err) => {});
    }

    if(this._wanStatus) {
      this._wanStatus.http = result;
    }

    // keep bluetooth up if status code is 3xx
    if(result.statusCode >= 300 && result.statusCode < 400) {
      this.log.info(`looks like ${this.name} has captive on, sending bluetooth control message...`);
      await pclient.publishAsync(Message.MSG_FIRERESET_BLUETOOTH_CONTROL, "1").catch((err) => {});
    }

    return result;
  }

  getWanStatus() {
    return this._wanStatus;
  }

  async checkWanConnectivity(defaultPingTestIP = ["1.1.1.1", "8.8.8.8", "9.9.9.9"], defaultPingTestCount = 8, defaultPingSuccessRate = 0.5, defaultDnsTestDomain = "github.com", forceExtraConf = {}, sendEvent = false) {
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
    let pingTestIP = defaultPingTestIP;
    if (extraConf && _.isArray(extraConf.pingTestIP)) {
      const ips = extraConf.pingTestIP.filter(ip => new Address4(ip).isValid());
      if (!_.isEmpty(ips))
        pingTestIP = ips;
    }
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
    const dnsTestDomain = (extraConf && extraConf.dnsTestDomain && validator.isFQDN(extraConf.dnsTestDomain)) ? extraConf.dnsTestDomain : defaultDnsTestDomain;
    const forceState = (extraConf && extraConf.forceState) || undefined;

    const carrierState = await this.carrierState();
    const operstateState = await this.operstateState();
    const r2c = await this.readyToConnect();
    if (!r2c) {
      this.log.warn(`Interface ${this.name} is not ready, carrier ${carrierState}, operstate ${operstateState}, directly mark as non-active`);
      active = false;
      carrierResult = false;
      failures.push({type: "carrier"});
    } else
      carrierResult = true;

    if (active && pingTestEnabled) {
      // no need to use Promise.any as ping test time for each target is the same
      // there is a way to optimize this is use spawn instead of exec to monitor number of received in real-time
      const rtid = await this._getRtId();
      await Promise.all(pingTestIP.map(async (ip) => {
        let cmd = `sudo ping -n -q -m ${rtid} -c ${pingTestCount} -W ${pingTestTimeout} -i 1 ${ip} | grep "received" | awk '{print $4}'`;
        return exec(cmd).then((result) => {
          if (!result || !result.stdout || Number(result.stdout.trim()) < pingTestCount * pingSuccessRate) {
            this.log.warn(`Failed to pass ping test to ${ip} on ${this.name}`);
            failures.push({type: "ping", target: ip});
            if (sendEvent)
              era.addStateEvent(EventConstants.EVENT_PING_STATE, this.name+"-"+ip, 1, {
                "wan_test_ip":ip,
                "wan_intf_name":wanName,
                "wan_intf_uuid":wanUUID,
                "ping_test_count":pingTestCount,
                "success_rate": (result && result.stdout) ? Number(result.stdout.trim())/pingTestCount : 0,
              });
            return false;
          } else
            if (sendEvent)
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
      const nameservers = await this.getDNSNameservers() || [];
      if (!_.isEmpty(nameservers)) {
        const _dnsResult = await this.getDNSResult(dnsTestDomain, sendEvent);
        if (!_dnsResult) {
          // add all nameservers to failures array
          for (const nameserver of nameservers)
            failures.push({ type: "dns", target: nameserver, domain: dnsTestDomain });
          this.log.error(`DNS test failed on all nameservers on ${this.name}`);
          active = false;
          dnsResult = false;
        } else {
          dnsResult = true;
        }
      } else {
        active = false;
        dnsResult = false;
        failures.push({ type: "dns", target: "no nameserver", domain: dnsTestDomain });
        this.log.error(`No DNS nameserver found on ${this.name}`);
      }
    }

    const result = {
      active: active, 
      forceState: carrierResult === true ? forceState : false, // do not honor forceState if carrier is not detected at all
      // Note! here the carrier result sent back to app is FALSE when interface is not ready to connect (carrier down or operstatus not ready or no ip address)
      carrier: carrierResult,
      ping: pingResult,
      dns: dnsResult,
      failures: failures,
      ts: Math.floor(new Date() / 1000),
      wanConnState: this.getWANConnState() || {}
    };

    if(!active) {
      result.recentDownTime = result.ts; // record the recent down time
    }

    const WLANInterfacePlugin = require('./wlan_intf_plugin.js')
    if (this instanceof WLANInterfacePlugin)
      result.essid = await this.getEssid();

    if(this._wanStatus) {
      this._wanStatus = Object.assign(this._wanStatus, result);
    }

    return result;
  }

  setPendingTest(v = false) {
    this._pendingTest = v;
    if (v)
      this._pendingTestTimestamp = Date.now() / 1000;
  }

  isPendingTest() {
    return this._pendingTest || false;
  }

  // use throw error for Promise.any
  async _getDNSResult(dnsTestDomain, srcIP, nameserver, sendEvent = false, af = 4) {
    const cmd = `dig -${af} -b ${srcIP} +time=3 +short +tries=2 @${nameserver} ${dnsTestDomain}`;
    this.log.debug("dig dns command:", cmd);
    const result = await exec(cmd).catch((err) => null);

    let dnsResult = null;

    if (result && result.stdout && result.stdout.trim().length !== 0)  {
      let lines = result.stdout.trim().split("\n");
      lines = lines.filter((l) => {
        return ip.isV4Format(l) || ip.isV6Format(l);
      });
      if (lines.length !== 0) {
        dnsResult = lines[0];
      }
    }

    const wanName = this.networkConfig && this.networkConfig.meta && this.networkConfig.meta.name;
    const wanUUID = this.networkConfig && this.networkConfig.meta && this.networkConfig.meta.uuid;

    if (sendEvent)
      era.addStateEvent(EventConstants.EVENT_DNS_STATE, af == 4 ? nameserver : `${nameserver}:[${srcIP}]`, dnsResult ? 0 : 1, {
        "wan_intf_name":wanName,
        "wan_intf_uuid":wanUUID,
        "wan_intf_address":srcIP,
        "name_server":nameserver,
        "dns_test_domain":dnsTestDomain
      });

    if(dnsResult) {
      return dnsResult;
    } else {
      throw new Error("no dns result");
    }
  }

  async getDNSResult(dnsTestDomain, sendEvent = false) {
    const nameservers = await this.getDNSNameservers();
    const ip4s = await this.getIPv4Addresses();
    const ip6s = await this.getIPv6Addresses();

    if (_.isArray(nameservers) && nameservers.length !== 0 && _.isArray(ip4s) && ip4s.length !== 0) {
      const srcIP = ip4s[0].split('/')[0];
      const promises = [];
      for(const nameserver of nameservers) {
        if (!new Address4(nameserver).isValid()) continue;
        promises.push(this._getDNSResult(dnsTestDomain, srcIP, nameserver, sendEvent));
      }
      if (!_.isEmpty(promises)) {
        const result = await Promise.any(promises).catch((err) => {
          this.log.warn("no valid ipv4 dns nameservers on", this.name, err.message);
        });
        if (result)
          return result;
      }
    }

    if (_.isArray(nameservers) && nameservers.length !== 0 && _.isArray(ip6s) && ip6s.length !== 0) {
      const srcIPs = ip6s.map(i => i.split('/')[0]);
      const promises = [];
      for(const nameserver of nameservers) {
        for (const srcIP of srcIPs) {
          const ipaddr  = new Address6(srcIP);
          if (!ipaddr.isValid() || ipaddr.isLinkLocal()) continue;
          if (!new Address6(nameserver).isValid()) continue;
          promises.push(this._getDNSResult(dnsTestDomain, srcIP, nameserver, sendEvent, 6));
        }
      }
      if (!_.isEmpty(promises)) {
        const result = await Promise.any(promises).catch((err) => {
          this.log.warn("no valid ipv6 dns nameservers on", this.name, err.message);
        });
        if (result)
          return result;
      }
    }
    this.log.error(`no valid dns from any nameservers on ${this.name}`);
    return null;
  }

  async renewDHCPLease() {
    const ts = Math.floor(Date.now() / 1000);
    const execSuccess = await exec(`sudo systemctl restart firerouter_dhclient@${this.name}`).then(() => true).catch((err) => false);
    if (!execSuccess)
      return null;
    while (true) {
      const info = await this.getLastDHCPLeaseInfo();
      if (info && Number(info.ts) >= ts)
        return info;
      await util.delay(1000);
      const curTs = Date.now() / 1000;
      if (curTs - ts > 30)
        return null;
    }
  }

  async getLastDHCPLeaseInfo() {
    const info = await rclient.zrangeAsync(`dhclient_record:${this.name}`, -1, -1).then((data) => data && JSON.parse(data)).catch((err) => null);
    return info;
  }

  async renewDHCP6Lease() {
    const execSuccess = await exec(`sudo systemctl restart firerouter_dhcpcd6@${this.name}`).then(() => true).catch((err) => false);
    if (!execSuccess)
      return null;
    await util.delay(5000);
    const info = await this.getLastDHCP6LeaseInfo();
    return info;
  }

  async getLastDHCP6LeaseInfo() {
    const info = {};
    const paths = [`/dev/shm/dhcpcd.ra.${this.name}`, `/dev/shm/dhcpcd.lease6.${this.name}`];
    for (const path of paths) {
      const content = await fs.readFileAsync(path, {encoding: "utf8"}).catch((err) => null);
      if (content) {
        const lines = content.split("\n").filter(line => line.length > 0);
        for (const line of lines) {
          const [ key, value ] = line.split('=', 2);
          switch (key) {
            case "ip6": {
              const ip6 = value && value.split(",").filter(ip => ip.length > 0);
              info.ip6 = ip6;
              break;
            }
            case "gw6": {
              const gw6 = value;
              if (gw6)
                info.gw6 = gw6;
              break;
            }
            case "ra_ts": {
              info.ra_ts = Number(value);
              break;
            }
            case "ra_vltime": {
              if (!isNaN(value))
                info.ra_lifetime = Number(value);
              break;
            }
            case "ia_na_vltimes": {
              const addresses = [];
              info["ia_na"] = {addresses};
              const ianas = value.split(",").filter(iana => iana.length > 0);
              for (const iana of ianas) {
                const [address, lifetime] = iana.split("@", 2);
                addresses.push({address, lifetime: lifetime && Number(lifetime)});
              }
              break;
            }
            case "ia_pd_vltimes": {
              const addresses = [];
              info["ia_pd"] = {addresses};
              const ianas = value.split(",").filter(iana => iana.length > 0);
              for (const iana of ianas) {
                const [address, lifetime] = iana.split("@", 2);
                addresses.push({address, lifetime: lifetime && Number(lifetime)});
              }
              break;
            }
            case "ts": {
              info.ts = Number(value);
              break;
            }
          }
        }
      }
    }
    return info;
  }

  async getSubIntfs() {
    return null;
  }

  async _getRtId() {
    if (!this.isWAN())
      return null;
    if (!this.rtId) {
      this.rtId = await routing.createCustomizedRoutingTable(`${this.name}_default`);
    }
    return this.rtId;
  }

  async state() {
    let [mac, mtu, carrier, duplex, speed, operstate, txBytes, rxBytes, rtid, ip4s, routableSubnets, ip6, gateway, gateway6, dns, origDns, dns6, origDns6, pds, present, subIntfs] = await Promise.all([
      this._getSysFSClassNetValue("address"),
      this._getSysFSClassNetValue("mtu"),
      this._getSysFSClassNetValue("carrier"),
      this._getSysFSClassNetValue("duplex"),
      this._getSysFSClassNetValue("speed"),
      this._getSysFSClassNetValue("operstate"),
      this._getSysFSClassNetValue("statistics/tx_bytes"),
      this._getSysFSClassNetValue("statistics/rx_bytes"),
      this._getRtId(),
      this.getIPv4Addresses(),
      this.getRoutableSubnets(),
      exec(`ip addr show dev ${this.name} | awk '/inet6 /' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout.trim() || null).catch((err) => null),
      routing.getInterfaceGWIP(this.name) || null,
      routing.getInterfaceGWIP(this.name, 6) || null,
      this.getDns4Nameservers(),
      this.getOrigDNSNameservers(),
      this.getDns6Nameservers(),
      this.getOrigDNS6Nameservers(),
      this.getPrefixDelegations(),
      this.isInterfacePresent(),
      this.getSubIntfs()
    ]);
    const ip4 = _.isEmpty(ip4s) ? null : ip4s[0];
    if (ip4 && ip4.length > 0 && !ip4.includes("/"))
      ip4 = `${ip4}/32`;
    if (ip6)
      ip6 = ip6.split("\n").filter(l => l.length > 0);
    let wanConnState = null;
    let wanTestResult = null;
    if (this.isWAN()) {
      wanConnState = this.getWANConnState() || {};
      wanTestResult = this._wanStatus; // use a different name to differentiate from existing wanConnState
    }
    return {mac, mtu, carrier, duplex, speed, operstate, txBytes, rxBytes, ip4, ip4s, routableSubnets, ip6, gateway, gateway6, dns, origDns, dns6, origDns6, pds, rtid, wanConnState, wanTestResult, present, subIntfs};
  }

  onEvent(e) {
    if (!event.isLoggingSuppressed(e))
      this.log.info(`Received event on ${this.name}`, e);
    const eventType = event.getEventType(e);
    switch (eventType) {
      case event.EVENT_IF_UP: {
        if (this.isWAN()) {
          // although pending test flag will be set after apply() is scheduled later, still need to set it here to prevent inconsistency in intermediate state
          this.setPendingTest(true);
          this._wanConnState = this._wanConnState || { ready: true, successCount: OFF_ON_THRESHOLD - 1, failureCount: 0 };
          this._wanConnState.successCount = OFF_ON_THRESHOLD - 1;
          this._wanConnState.failureCount = ON_OFF_THRESHOLD - 1;
          if (this.hasHardwareAddress()) {
            // WAN interface plugged, need to restart dhcp client if applicable
            if (this.isDHCP()) {
              if (this.networkConfig.dhcp) {
                this.flushIP(4).then(() => this.renewDHCPLease()).catch((err) => {
                  this.log.error(`Failed to renew DHCP lease on interface ${this.name}`, err.message);
                });
              }
              if (this.networkConfig.dhcp6) {
                this.flushIP(6).then(() => this.renewDHCP6Lease()).catch((err) => {
                  this.log.error(`Failed to renew DHCPv6 lease on interface ${this.name}`, err.message);
                });
              }
            }
          } else {
            // for interface that does not have L2, e.g., pppoe, simply reapply config on it
            this.propagateConfigChanged(true);
            pl.scheduleReapply();
          }
        }
        break;
      }
      case event.EVENT_IF_PRESENT:
      case event.EVENT_IF_DISAPPEAR: {
        if (this.networkConfig && this.networkConfig.allowHotplug === true && platform.isHotplugSupported(this.name)) {
          pl.acquireApplyLock(async () => {
            platform.clearMacCache(this.name);
            this._reapplyNeeded = true;
            // trigger downstream plugins to reapply config
            this.propagateConfigChanged(true);
            pl.scheduleReapply();
          });
        }
        break;
      }
      case event.EVENT_DNS6_CHANGE: {
        const payload = event.getEventPayload(e);
        if (payload.intf === this.name && this.isWAN()) {
          // update DNS from DHCP
          pl.acquireApplyLock(async () => {
            await this.applyDnsSettings().then(() => this.updateRouteForDNS()).catch((err) => {
              this.log.error(`Failed to apply DNS settings and update DNS route on ${this.name}`, err.message);
            });
            this.propagateConfigChanged(true);
            this._reapplyNeeded = false;
            pl.scheduleReapply();
            return pl.publishIfaceChangeApplied();
          }).catch((err) => {
            this.log.error(`Failed to apply DNSv6 settings on ${this.name}`, err.message);
          });
        }
        break;
      }
      case event.EVENT_PD_CHANGE: {
        const payload = event.getEventPayload(e);
        const iface = payload.intf;
        if (iface && this.networkConfig.ipv6DelegateFrom === iface) {
          // the interface from which prefix is delegated is changed, need to reapply ipv6 settings
          pl.acquireApplyLock(async () => {
            await this.flushIP(6).then(() => this.applyIpv6Settings()).then(() => this.changeRoutingTables()).then(() => {
              // trigger downstream plugins to reapply, e.g., nat for ipv6
              this.propagateConfigChanged(true);
              this._reapplyNeeded = false;
              pl.scheduleReapply();
              return pl.publishIfaceChangeApplied();
            }).catch((err) => {
              this.log.error(`Failed to apply IPv6 settings for prefix delegation change from ${iface} on ${this.name}`, err.message);
            });
          });
        }
        break;
      }
      case event.EVENT_IP_CHANGE: {
        const payload = event.getEventPayload(e);
        const iface = payload.intf;
        if (iface === this.name && this.isWAN()) {
          this._wanConnState = this._wanConnState || { ready: true, successCount: OFF_ON_THRESHOLD - 1, failureCount: 0 };
          this._wanConnState.successCount = OFF_ON_THRESHOLD - 1;
          this._wanConnState.failureCount = ON_OFF_THRESHOLD - 1;
          // update route for DNS from DHCP
          this.applyDnsSettings().then(() => this.updateRouteForDNS()).catch((err) => {
            this.log.error(`Failed to apply DNS settings and update DNS route on ${this.name}`, err.message);
          })
          this.markOutputConnection().catch((err) => {
            this.log.error(`Failed to add outgoing mark on ${this.name}`, err.message);
          })
          pl.publishIfaceChangeApplied();
        }
        break;
      }
      case event.EVENT_WAN_CONN_CHECK: {
        const payload = event.getEventPayload(e);
        if (!payload)
          return;
        const intf = payload.intf;
        if (intf !== this.name)
          return;
        const wasPendingTest = this.isPendingTest();
        const active = payload.active || false;
        const forceState = payload.forceState;
        const failures = payload.failures;
        this._wanConnState = this._wanConnState || {};
        const currentStatus = this._wanConnState;
        if (active) {
          currentStatus.successCount++;
          currentStatus.failureCount = 0;
        } else {
          if (this.isEthernetBasedInterface()) {
            platform.resetEthernet().catch((err) => {
              this.log.error(`Failed to reset ethernet on ${this.name}`, err.message);
            });
          }
          currentStatus.successCount = 0;
          currentStatus.failureCount++;
          const failureMultipliers = currentStatus.failureCount / DHCP_RESTART_INTERVAL;
          if (currentStatus.failureCount % DHCP_RESTART_INTERVAL == 0 && // exponential-backoff
            (failureMultipliers == 1 || failureMultipliers == 2 || failureMultipliers == 4 || failureMultipliers == 8 || failureMultipliers % 16 == 0)) {
            if (this.networkConfig.dhcp) {
              this.carrierState().then((result) => {
                if (result === "1") {
                  this.gatewayReachable().then((reachable) => {
                    const routingPlugin = pl.getPluginInstance("routing", "global");
                    // renew dhcp lease if gateway is unreachable or internet is down globally
                    if (!reachable || (routingPlugin && _.isEmpty(routingPlugin.getActiveWANPlugins()))) {
                      this.log.info(`Restarting DHCP client on interface ${this.name}, failure count is ${currentStatus.failureCount} ...`);
                      this.renewDHCPLease().catch((err) => {
                        this.log.error(`Failed to renew DHCP lease on interface ${this.name}`, err.message);
                      });
                    }
                  }).catch((err) => {});
                }
              });
            }
          }
        }
        this.setPendingTest(false);
        let changeDesc = null;
        if (currentStatus.ready && (forceState !== true && currentStatus.failureCount >= ON_OFF_THRESHOLD || forceState === false)) {
          currentStatus.ready = false;
          changeDesc = { intf, ready: false, failures };
        }
        if (!currentStatus.ready && (forceState !== false && (currentStatus.successCount >= OFF_ON_THRESHOLD) || forceState === true)) {
          currentStatus.ready = true;
          changeDesc = { intf, ready: true, failures };
        }
        if (wasPendingTest) {
          const duration = this._pendingTestTimestamp ? (Math.floor(Date.now() / 1000) - this._pendingTestTimestamp) : 0;
          this.log.info(`Finished 1st wan status test (took ${duration} seconds) after config change, ${this.name} final status: `, currentStatus);
        }
        if (!changeDesc && wasPendingTest) {
          changeDesc = { intf, ready: currentStatus.ready, failures }
        }
        if (changeDesc)
          this.publishWANStateChange(changeDesc);
        break;
      }
      default:
    }
  }

  isReady() {
    return this._wanConnState && this._wanConnState.ready || false;
  }

  async publishWANStateChange(changeDesc) {
    this.log.info("publish WAN state change", changeDesc);
    await pclient.publishAsync(Message.MSG_FR_WAN_STATE_CHANGED, JSON.stringify(changeDesc)).catch((err) => {});
  }

  isEthernetBasedInterface() {
    return false;
  }
}

module.exports = InterfaceBasePlugin;