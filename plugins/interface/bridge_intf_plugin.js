'use strict';

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');
const exec = require('child-process-promise').exec;
const routing = require('../../util/routing.js');
const _ = require('lodash');
const ip = require('ip');

class BridgeInterfacePlugin extends Plugin {

  async flush() {
    log.info("Flushing bridge", this.name);
    await exec(`sudo ip link set dev ${this.name} down`).catch((err) => {
      log.error(`Failed to bring down interface ${this.name}`, err);
    });
    await exec(`sudo brctl delbr ${this.name}`).catch((err) => {
      log.error(`Failed to delete bridge ${this.name}`, err);
    });
  }

  async prepareEnvironment() {
    // create routing tables and add rules for interface
    if (this.networkConfig && this.networkConfig.ipv4) {
      await routing.initializeInterfaceRoutingTables(this.name);
      await routing.createInterfaceRoutingRules(this.name);
      await routing.createInterfaceGlobalRoutingRules(this.name);
    }
  }

  async changeRoutingTables() {
    const ip4 = await exec(`ip addr show dev ${this.name} | grep 'inet ' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout).catch((err) => null);
    if (!ip4)
      return;
    const cidr = ip.cidrSubnet(ip4);
    await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, `${this.name}_local`).catch((err) => {});
    await routing.addRouteToTable(`${cidr.networkAddress}/${cidr.subnetMaskLength}`, null, this.name, routing.RT_ROUTABLE).catch((err) => {});
  }

  async apply() {
    log.info(`Setup network ${this.name} with config`, this.networkConfig);

    if(_.isEmpty(this.networkConfig.intf)) {
      log.error("Invalid bridge config");
      return;
    }

    if(!this.networkConfig.enabled) {
      log.info(`Interface ${this.name} is disabled`);
      return;
    }

    await this.prepareEnvironment();

    for(const intf of this.networkConfig.intf) {
      await exec(`sudo ip addr flush dev ${intf}`);
    }

    await exec(`sudo brctl addbr ${this.name}`);
    await exec(`sudo brctl addif ${this.name} ${this.networkConfig.intf.join(" ")}`);
    await exec(`sudo ip link set dev ${this.name} up`);

    if(this.networkConfig.ipv4) {
      await exec(`sudo ip addr add ${this.networkConfig.ipv4} dev ${this.name}`).then(() => {
        return this.changeRoutingTables();
      }).catch((err) => {
        log.error(`Got error when setup ipv4: ${err.message}`);
      });

    }
  }

  async _getSysFSClassNetValue(key) {
    const value = await exec(`sudo cat /sys/class/net/${this.name}/${key}`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => {
      log.error(`Failed to get ${key} of ${this.name}`, err.message);
      return null;
    })
    return value;
  }

  async state() {
    const mac = await this._getSysFSClassNetValue("address");
    const mtu = await this._getSysFSClassNetValue("mtu");
    const carrier = await this._getSysFSClassNetValue("carrier");
    /* duplex and speed of bridge interface is not readable
    const duplex = await this._getSysFSClassNetValue("duplex");
    const speed = await this._getSysFSClassNetValue("speed");
    */
    const operstate = await this._getSysFSClassNetValue("operstate");
    const ip4 = await exec(`ip addr show dev ${this.name} | grep 'inet ' | awk '{print $2}'`, {encoding: "utf8"}).then((result) => result.stdout.trim()).catch((err) => null);
    return {mac, mtu, carrier, operstate, ip4};
  }
}

module.exports = BridgeInterfacePlugin;