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

const Plugin = require('../plugin.js');
const util = require('../../util/util.js');

const exec = require('child-process-promise').exec;

class ICMPPlugin extends Plugin {

  async flush() {
    for (const type of Object.keys(this.networkConfig)) {
      switch (type) {
        case "echoRequest": {
          await exec(util.wrapIptables(`sudo iptables -w -D FR_ICMP -i ${this.name} -p icmp --icmp-type 8 -j DROP`)).catch((err) => {});
          await exec(util.wrapIptables(`sudo ip6tables -w -D FR_ICMP -i ${this.name} -p icmpv6 --icmpv6-type 128 -j DROP`)).catch((err) => {});
          break;
        }
        default:
          this.log.error(`Unsupported icmp type ${type} for ${this.name}`);
      }
    }
  }

  async apply() {
    if (!this.networkConfig) {
      this.fatal(`Network config of ${this.name} is not given.`);
      return;
    }
    for (const type of Object.keys(this.networkConfig)) {
      const value = this.networkConfig[type];
      switch (type) {
        case "echoRequest": {
          if (value === true) {
            await exec(util.wrapIptables(`sudo iptables -w -D FR_ICMP -i ${this.name} -p icmp --icmp-type 8 -j DROP`)).catch((err) => {
              this.log.error(`Failed to enable ICMP echo request on ${this.name}`, err.message);
            });
            await exec(util.wrapIptables(`sudo ip6tables -w -D FR_ICMP -i ${this.name} -p icmpv6 --icmpv6-type 128 -j DROP`)).catch((err) => {
              this.log.error(`Failed to enable ICMPv6 echo request on ${this.name}`, err.message);
            });
          } else {
            await exec(util.wrapIptables(`sudo iptables -w -A FR_ICMP -i ${this.name} -p icmp --icmp-type 8 -j DROP`)).catch((err) => {
              this.log.error(`Failed to disable ICMP echo request on ${this.name}`, err.message);
            });
            await exec(util.wrapIptables(`sudo ip6tables -w -A FR_ICMP -i ${this.name} -p icmpv6 --icmpv6-type 128 -j DROP`)).catch((err) => {
              this.log.error(`Failed to disable ICMPv6 echo request on ${this.name}`, err.message);
            });
          }
          break;
        }
        default:
          this.log.error(`Unsupported icmp type ${type} for ${this.name}`);
      }
    }
  }
}

module.exports = ICMPPlugin;