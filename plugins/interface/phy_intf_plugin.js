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

Promise.promisifyAll(fs);


class PhyInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    // copy dhclient hook script
    await exec(`sudo rm -f /etc/dhcp/dhclient-exit-hooks.d/firerouter_*`).catch((err) => {});
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_dhclient_ip_change /etc/dhcp/dhclient-exit-hooks.d/`);
    // copy firerouter_dhclient.service
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_dhclient@.service /etc/systemd/system/`);
    await exec("sudo systemctl daemon-reload");
  }

}

module.exports = PhyInterfacePlugin;