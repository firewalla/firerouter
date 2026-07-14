/*    Copyright 2026 Firewalla Inc.
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

const { exec } = require('child-process-promise');
const log = require('../util/logger.js')('util');

class SysCtl {
  /**
   * Get the value of a sysctl parameter
   * @param {string} parameter - The sysctl parameter name (e.g., 'net.ipv4.ip_forward')
   * @returns {Promise<string|null>} The value of the parameter, or null on error
   */
  async getValue(parameter) {
    if (!parameter) {
      throw new Error('Parameter is required');
    }

    try {
      const result = await exec(`sudo sysctl -n ${parameter}`);
      return result.stdout.trim();
    } catch (err) {
      log.error(`Failed to get sysctl value for ${parameter}:`, err.message);
      return null;
    }
  }

  /**
   * Set the value of a sysctl parameter
   * @param {string} parameter - The sysctl parameter name (e.g., 'net.ipv4.ip_forward')
   * @param {string|number} value - The value to set
   * @returns {Promise<void>}
   */
  async setValue(parameter, value) {
    if (!parameter) {
      throw new Error('Parameter is required');
    }

    try {
      await exec(`sudo sysctl -w ${parameter}=${value}`);
      log.debug(`Set sysctl ${parameter}=${value}`);
    } catch (err) {
      log.error(`Failed to set sysctl value for ${parameter}=${value}:`, err);
    }
  }
}

module.exports = new SysCtl();
