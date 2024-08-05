/*    Copyright 2021 Firewalla Inc
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

const InterfaceBasePlugin = require('./intf_base_plugin.js');

const exec = require('child-process-promise').exec;
const _ = require('lodash');
const {Address4, Address6} = require('ip-address');

class DockerInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    const hasContainer = await exec(`sudo ls /var/lib/docker/containers -1 | wc -l`).then((result) => result.stdout.trim() !== "0").catch((err) => false);
    if (hasContainer)
      await exec(`sudo systemctl start docker`).catch((err) => {});
    else
      await exec(`sudo systemctl stop docker`).catch((err) => {});
  }

  async flush() {
    await super.flush();
    await this._testAndStartDocker();
    await exec(`sudo docker network rm ${this.name}`).catch((err) => {
      this.log.error(`Failed to remove docker network ${this.name}: ${err.message}`);
    });
  }

  async _testAndStartDocker() {
    const active = await exec(`sudo systemctl -q is-active docker`).then(() => true).catch((err) => false);
    if (!active)
      await exec(`sudo systemctl start docker`).catch((err) => {});
  }

  async _checkNetworkExists() {
    const result = await exec(`sudo docker network ls -f name=${this.name} -q`).then((result) => result.stdout.trim()).catch((err) => "");
    return result !== "";
  }

  async createInterface() {
    await this._testAndStartDocker();
    const exists = await this._checkNetworkExists();
    if (exists) {
      // do not recreate interface if it already exists
      // this is because super.flush will fail to remove networks if there are containers attached to the network
      // and this is very likely that there are running containers in production
      // so we just skip the creation instead of breaking the apply process
      this.log.info("Docker network already exists, skip creation");
      return true;
    }

    const driver = this.networkConfig.driver || "bridge";
    const intfName = this.name;
    const subnets = [];
    const opts = this.networkConfig.options || [];
    // make opts immutable
    const optsCopy = JSON.parse(JSON.stringify(opts));
    optsCopy.push(`--driver=${driver}`);
    let ip4s = this.networkConfig.ipv4s || [];
    if (this.networkConfig.ipv4)
      ip4s.push(this.networkConfig.ipv4);
    ip4s = _.uniq(ip4s);
    for (const ip4 of ip4s) {
      const ip4Addr = new Address4(ip4);
      const subnet = `${ip4Addr.startAddress().correctForm()}/${ip4Addr.subnetMask}`;
      const ipRange = subnet;
      const gateway = ip4Addr.addressMinusSuffix;
      if (!subnets.includes(subnet)) {
        subnets.push(subnet);
        Array.prototype.push.apply(optsCopy, [`--subnet=${subnet}`, `--ip-range=${ipRange}`, `--gateway=${gateway}`]);
      } else {
        this.log.error(`IPv4 address ${ip4} overlapped with another subnet on ${intfName} and will be skipped`);
      }
    }
    const ip6s = this.networkConfig.ipv6 || [];
    for (const ip6 of ip6s) {
      const ip6Addr = new Address6(ip6);
      const subnet = `${ip6Addr.startAddress().correctForm()}/${ip6Addr.subnetMask}`;
      const ipRange = subnet;
      const gateway = ip6Addr.addressMinusSuffix;
      if (!subnets.includes(subnet)) {
        subnets.push(subnet);
        Array.prototype.push.apply(optsCopy, [`--subnet=${subnet}`, `--ip-range=${ipRange}`, `--gateway=${gateway}`]);
      } else {
        this.log.error(`IPv6 address ${ip6} overlapped with another subnet on ${intfName} and will be skipped`);
      }
    }
    const driverOpts = this.networkConfig.driverOptions || [];
    // make driverOpts immutable
    const driverOptsCopy = JSON.parse(JSON.stringify(driverOpts));

    if (driver === "bridge") {
      driverOptsCopy.push(`"com.docker.network.bridge.name"="${intfName}"`);
    }
    const args = optsCopy.concat(driverOptsCopy.map(opt => `-o ${opt}`));
    await exec(`sudo docker network create ${args.join(" ")} ${intfName}`).catch((err) => {
      this.fatal(`Failed to create docker network ${this.name}`, err.message);
    });
    return true;
  }
}

module.exports = DockerInterfacePlugin;
