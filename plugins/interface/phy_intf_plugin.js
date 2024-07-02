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

const InterfaceBasePlugin = require('./intf_base_plugin.js');
const r = require('../../util/firerouter.js');
const fs = require('fs');
const Promise = require('bluebird');
const exec = require('child-process-promise').exec;
const platform = require('../../platform/PlatformLoader.js').getPlatform();

Promise.promisifyAll(fs);


class PhyInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    // override ethernet kernel module
    await platform.overrideEthernetKernelModule();
    // configure ethernet
    await platform.configEthernet();
    // copy dhclient hook script
    await exec(`sudo rm -f /etc/dhcp/dhclient-exit-hooks.d/firerouter_*`).catch((err) => {});
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_dhclient_ip_change /etc/dhcp/dhclient-exit-hooks.d/`);
    // copy dhcpcd hook script
    await exec(`sudo rm -r /lib/dhcpcd/dhcpcd-hooks/firerouter_*`).catch((err) => {});
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_dhcpcd_update_rt /lib/dhcpcd/dhcpcd-hooks/`);
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_dhcpcd_record_pd /lib/dhcpcd/dhcpcd-hooks/`);
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_dhcpcd_record_lease /lib/dhcpcd/dhcpcd-hooks/`);
    // copy firerouter_dhclient@.service
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_dhclient@.service /etc/systemd/system/`);
    // copy firerouter_dhcpcd6@.service
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_dhcpcd6@.service /etc/systemd/system/`);
  }

  async prepareEnvironment() {
    await super.prepareEnvironment();
    if (this.networkConfig.enabled) {
      const maxTxRing = await exec(`sudo ethtool -g ${this.name} | grep "^TX:" | head -n 1 | awk '{print $2}'`).then((result) => result.stdout.trim()).catch((err) => null);
      const maxRxRing = await exec(`sudo ethtool -g ${this.name} | grep "^RX:" | head -n 1 | awk '{print $2}'`).then((result) => result.stdout.trim()).catch((err) => null);
      const txRingBuffer = this.networkConfig.txBuffer || maxTxRing || 4096;
      const rxRingBuffer = this.networkConfig.rxBuffer || maxRxRing || 4096;
      this.log.info(`Set TX ring to ${txRingBuffer}, RX ring to ${rxRingBuffer} on ${this.name}`);
      await exec(`sudo ethtool -G ${this.name} tx ${txRingBuffer} rx ${rxRingBuffer}`).catch((err) => {});
    }
  }

  getDefaultMTU() {
    return 1500;
  }

}

module.exports = PhyInterfacePlugin;
