/*    Copyright 2016-2020 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
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

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

class Platform {
  getName() {
  }

  getType() {
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/../network/default_setup.json`;
  }

  async getWlanVendor() {
    return '';
  }

  getWpaCliBinPath() {
    return null;
  }

  async ledNormalVisibleStart() {
  }

  async ledNormalVisibleStop() {
  }
}

module.exports = Platform;
