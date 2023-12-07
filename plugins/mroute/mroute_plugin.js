/*    Copyright 2023 Firewalla Inc
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
const exec = require('child-process-promise').exec;
const r = require('../../util/firerouter.js');
const fsp = require('fs').promises;
const util = require('../../util/util.js');
const {Address4, Address6} = require('ip-address');
const pl = require('../plugin_loader.js');
const _ = require('lodash');


class MRoutePlugin extends Plugin {
  static async preparePlugin() {
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_smcrouted.service /etc/systemd/system/`);
    await exec(`mkdir -p ${MRoutePlugin.getConfDir()}`);
    await fsp.writeFile(`${MRoutePlugin.getConfBaseDir()}/smcroute.conf`, `include ${MRoutePlugin.getConfDir()}/*.conf`, {encoding: "utf8"});
  }

  static getConfBaseDir() {
    return `${r.getUserConfigFolder()}/smcroute`
  }

  static getConfDir() {
    return `${MRoutePlugin.getConfBaseDir()}/conf`;
  }

  async flush() {
    await fsp.unlink(`${MRoutePlugin.getConfDir()}/${this.name}.conf`).catch((err) => {});
    for (const route of this.networkConfig.routes) {
      const {cidr} = route;
      if (new Address4(cidr).isValid()) {
        if (!_.isEmpty(this._ip4s)) {
          for (const ip4 of this._ip4s)
            await exec(util.wrapIptables(`sudo iptables -w -t mangle -D FR_MROUTE -p udp -i ${this.name} -s ${ip4} -d ${cidr} -j TTL --ttl-inc 1`)).catch((err) => {});
        }
      } else {
        if (new Address6(cidr).isValid()) {
          await exec(util.wrapIptables(`sudo ip6tables -w -t mangle -D FR_MROUTE -p udp -i ${this.name} -d ${cidr} -j HL --hl-inc 1`)).catch((err) => {});
        } else
          this.log.error(`Invalid cidr ${cidr}`);
      }
    }
    if (!_.isEmpty(this._oifHWAddrs)) {
      for (const hwAddr of this._oifHWAddrs) {
        await exec(util.wrapIptables(`sudo iptables -w -t mangle -D FR_MROUTE -p udp -i ${this.name} -m mac --mac-source ${hwAddr} -j RETURN`)).catch((err) => {});
        await exec(util.wrapIptables(`sudo ip6tables -w -t mangle -D FR_MROUTE -p udp -i ${this.name} -m mac --mac-source ${hwAddr} -j RETURN`)).catch((err) => {});
      }
    }
    this._oifHWAddrs = [];
    await exec(`sudo systemctl stop firerouter_smcrouted.service`).catch((err) => {});
    const files = await fsp.readdir(MRoutePlugin.getConfDir());
    if (!_.isEmpty(files))
      await exec(`sudo systemctl start firerouter_smcrouted.service`).catch((err) => {});
  }

  async apply() {
    const iifIntfPlugin = pl.getPluginInstance("interface", this.name);
    if (!iifIntfPlugin)
      this.fatal(`Cannot find interface plugin ${this.name}`);
    this.subscribeChangeFrom(iifIntfPlugin);
    if (await iifIntfPlugin.isInterfacePresent() === false) {
      this.log.warn(`Interface ${this.name} is not present yet`);
      return;
    }
    const phyints = [this.name];
    const mroutes = [];
    const ip4s = await iifIntfPlugin.getIPv4Addresses();
    this._ip4s = ip4s;
    for (const route of this.networkConfig.routes) {
      const {cidr, oifs} = route;
      if (new Address4(cidr).isValid()) {
        if (!_.isEmpty(this._ip4s)) {
          // add source address check to filter some invalid packets due to loop
          for (const ip4 of this._ip4s)
            await exec(util.wrapIptables(`sudo iptables -w -t mangle -A FR_MROUTE -p udp -i ${this.name} -s ${ip4} -d ${cidr} -j TTL --ttl-inc 1`)).catch((err) => {});
        }
      } else {
        if (new Address6(cidr).isValid()) {
          // source address check on IPv6 is not implemented yet because most use cases are on IPv4
          await exec(util.wrapIptables(`sudo ip6tables -w -t mangle -A FR_MROUTE -p udp -i ${this.name} -d ${cidr} -j HL --hl-inc 1`)).catch((err) => {});
        } else
          this.log.error(`Invalid cidr ${cidr}`);
      }
      mroutes.push(`mgroup from ${this.name} group ${cidr}`);
      const oifHWAddrs = {};
      for (const oif of oifs) {
        if (oif === this.name) {
          this.log.warn(`Outgoing interface ${oif} is same as incoming interface, ignore`);
          continue;
        }
        const oifIntfPlugin = pl.getPluginInstance("interface", oif);
        if (!oifIntfPlugin)
          this.fatal(`Cannot find interface plugin ${oif}`);
        if (await oifIntfPlugin.isInterfacePresent() === false)
          continue;
        const hwAddr = await oifIntfPlugin.getHardwareAddress();
        if (hwAddr) {
          oifHWAddrs[hwAddr] = 1;
          // do not process incoming multicast packets that are transmitted from the oifs
          await exec(util.wrapIptables(`sudo iptables -w -t mangle -I FR_MROUTE -p udp -i ${this.name} -m mac --mac-source ${hwAddr} -j RETURN`)).catch((err) => {});
          await exec(util.wrapIptables(`sudo ip6tables -w -t mangle -I FR_MROUTE -p udp -i ${this.name} -m mac --mac-source ${hwAddr} -j RETURN`)).catch((err) => {});
        }
        this._oifHWAddrs = Object.keys(oifHWAddrs);
        phyints.push(oif);
        if (new Address4(cidr).isValid()) {
          mroutes.push(`mroute from ${this.name} group ${cidr} to ${oif}`);
        } else {
          if (new Address6(cidr).isValid()) {
            mroutes.push(`mroute from ${this.name} group ${cidr} to ${oif}`);
          } else
            this.log.error(`Invalid cidr ${cidr}`);
        }
      }
    }
    const content = _.uniq(phyints).map(intf => `phyint ${intf} enable`).join('\n') + "\n" + mroutes.join('\n');
    await fsp.writeFile(`${MRoutePlugin.getConfDir()}/${this.name}.conf`, content).catch((err) => {
      this.log.error(`Failed to write 01_${this.name}.conf`, err.message);
    });
    await exec(`sudo systemctl stop firerouter_smcrouted.service`).then(() => exec(`sudo systemctl start firerouter_smcrouted.service`)).catch((err) => {});
  }
}

module.exports = MRoutePlugin;