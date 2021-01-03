/*    Copyright 2020 Firewalla Inc
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
const r = require('../../util/firerouter.js');
const fs = require('fs');
const _ = require('lodash');
const routing = require('../../util/routing.js');
const util = require('../../util/util.js');


const Promise = require('bluebird');
Promise.promisifyAll(fs);

class GenericTunInterfacePlugin extends InterfaceBasePlugin {

  async flush() {
    await super.flush();
    await exec(`sudo ip link set ${this.name} down`).catch((err) => {});
    await exec(`sudo ip link del dev ${this.name}`).catch((err) => {});
  }

  async createInterface() {
    await exec(`sudo ip tuntap add mode tun user ${this.networkConfig.user || "pi"} name ${this.name}`);
    await exec(`sudo ifconfig ${this.name} up`);
  }  
  
}

module.exports = GenericTunInterfacePlugin;