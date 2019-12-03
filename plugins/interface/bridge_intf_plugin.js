'use strict';

const log = require('../../util/logger.js')(__filename);

const InterfaceBasePlugin = require('./phy_intf_plugin.js');
const exec = require('child-process-promise').exec;

class BridgeInterfacePlugin extends InterfaceBasePlugin {

  async flush() {
    await super.flush();
    if (this.networkConfig && this.networkConfig.enabled) {
      await exec(`sudo ip link set dev ${this.name} down`).catch((err) => {
        log.error(`Failed to bring down interface ${this.name}`, err.message);
      });
      await exec(`sudo brctl delbr ${this.name}`).catch((err) => {
        log.error(`Failed to delete bridge ${this.name}`, err.message);
      });
    }
  }

  async createInterface() {
    for(const intf of this.networkConfig.intf) {
      await exec(`sudo ip addr flush dev ${intf}`);
    }

    await exec(`sudo brctl addbr ${this.name}`).catch((err) => {
      log.error(`Failed to create bridge interface ${this.name}`, err.message);
    });
    await exec(`sudo brctl addif ${this.name} ${this.networkConfig.intf.join(" ")}`).catch((err) => {
      log.error(`Failed to add interfaces to bridge ${this.name}`, err.message);
    });
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