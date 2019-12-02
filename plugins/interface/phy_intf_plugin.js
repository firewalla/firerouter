'use strict';

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');
const _ = require('lodash');

const r = require('../../util/firerouter');

const exec = require('child-process-promise').exec;

const fs = require('fs');
const Promise = require('bluebird');
const ip = require('ip');

Promise.promisifyAll(fs);

const routing = require('../../util/routing.js');

class PhyInterfacePlugin extends Plugin {

  async flush() {
    await exec(`sudo ip addr flush dev ${this.name}`).catch((err) => {
      log.error(`Failed to flush ip address of ${this.name}`, err);
    });

    if (this.networkConfig && this.networkConfig.enabled) {
      if (this.networkConfig.dhcp)
        await exec(`cat ${this._getDHClientPidFilePath()}`).then((result) => exec(`sudo kill -9 ${result.stdout.trim()}`)).catch((err) => {});
      
      await routing.flushRoutingTable(`${this.name}_local`).catch((err) => {});
      await routing.flushRoutingTable(`${this.name}_default`).catch((err) => {});
      await routing.removePolicyRoutingRule("all", this.name, `${this.name}_local`).catch((err) => {});
      await routing.removePolicyRoutingRule("all", this.name, `${this.name}_default`).catch((err) => {});
      await routing.removePolicyRoutingRule("all", this.name, routing.RT_GLOBAL_DEFAULT).catch((err) => {});
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

  async prepareEnvironment() {
    // create routing tables and add rules for interface
    if (this.networkConfig && (this.networkConfig.ipv4 || this.networkConfig.dhcp)) {
      await routing.initializeInterfaceRoutingTables(this.name);
      await routing.createInterfaceRoutingRules(this.name);
      await routing.createInterfaceGlobalRoutingRules(this.name);
    }
  }

  async applyIpSettings() {
    if (this.networkConfig.dhcp) {
      await exec(`sudo dhclient -pf ${this._getDHClientPidFilePath()} -lf ${this._getDHClientLeaseFilePath()} -i ${this.name} -e rt_tables="${this.name}_local main" -e default_rt_tables="${this.name}_default main"`).catch((err) => {
        log.error(`Failed to enable dhclient on interface ${this.name}`, err);
      });

      await fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name)).catch((err) => {});
      await fs.symlinkAsync(this._getResolvConfFilePath(), r.getInterfaceResolvConfPath(this.name));
    } else {
      if (this.networkConfig.ipv4) {
        await exec(`sudo ip addr add ${this.networkConfig.ipv4} dev ${this.name}`).then(() => {
        }).catch((err) => {
          log.error(`Failed to set ipv4 for interface ${this.name}`, err.message);
        })
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
    if (this.networkConfig && (this.networkConfig.gateway || this.networkConfig.dhcp)) {
      // considered as WAN interface, accessbile to "routable"
      await routing.createPolicyRoutingRule("all", this.name, routing.RT_ROUTABLE, 5001).catch((err) => {});
    } else {
      // considered as LAN interface, add to "routable"
      await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, routing.RT_ROUTABLE).catch((err) => {});
    }
  }

  async apply() {
    log.info(`Setup network ${this.name} with config`, this.networkConfig);
    if(_.isEmpty(this.networkConfig)) {
      log.info("Nothing to configure");
      return;
    }

    await this.prepareEnvironment();

    if(this.networkConfig.enabled) {
      await exec(`sudo ip link set ${this.name} up`).catch((err) => {
        log.error(`Failed to bring up interface ${this.name}`, err);
      });
    } else {
      await exec(`sudo ip link set ${this.name} down`).catch((err) => {
        log.error(`Failed to bring down interface ${this.name}`, err);
      });
      return;
    }

    await this.applyIpSettings();

    await this.changeRoutingTables();
  }

  async _getSysFSClassNetValue(key) {
    const value = await exec(`sudo cat /sys/class/net/${this.name}/${key}`, {encoding: "utf8"}).then((result) => result.stdout).catch((err) => {
      log.error(`Failed to get ${key} of ${this.name}`, err);
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
    const ip4 = await exec(`ip addr show dev ${this.name} | grep 'inet ' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout).catch((err) => null);
    return {mac, mtu, carrier, duplex, speed, operstate, ip4};
  }
}

module.exports = PhyInterfacePlugin;