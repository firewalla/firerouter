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
const exec = require('child-process-promise').exec;
const util = require('../../util/util.js');

class NATPassthroughPlugin extends Plugin {
  static async preparePlugin() {
    await exec(`sudo modprobe nf_conntrack`).then(() => {
      return exec(`sudo sysctl -w net.netfilter.nf_conntrack_helper=1`);
    }).catch((err) => {});
  }

  async flush() {
    switch (this.name) {
      case "pptp": {
        await exec("sudo rmmod nf_nat_pptp").catch((err) => {});
        await exec("sudo rmmod nf_conntrack_pptp").catch((err) => {});
        await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p gre -j DROP")}`).catch((err) => {});
        await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p tcp -m tcp --dport 1723 -j DROP")}`).catch((err) => {});
        await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p gre -j DROP")}`).catch((err) => {});
        await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p tcp -m tcp --dport 1723 -j DROP")}`).catch((err) => {});
        break;
      }
      case "l2tp": {
        await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p udp -m udp --dport 1701 -j DROP")}`).catch((err) => {});
        await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p udp -m udp --dport 1701 -j DROP")}`).catch((err) => {});
        break;
      }
      case "ipsec": {
        await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p udp -m udp --dport 4500 -j DROP")}`).catch((err) => {});
        await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p udp -m udp --dport 500 -j DROP")}`).catch((err) => {});
        await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p udp -m udp --dport 4500 -j DROP")}`).catch((err) => {});
        await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p udp -m udp --dport 500 -j DROP")}`).catch((err) => {});
        break;
      }
      case "h323": {
        await exec("sudo rmmod nf_nat_h323").catch((err) => {});
        await exec("sudo rmmod nf_conntrack_h323").catch((err) => {});
        break;
      }
      case "sip": {
        await exec("sudo rmmod nf_nat_sip").catch((err) => {});
        await exec("sudo rmmod nf_conntrack_sip").catch((err) => {});
        break;
      }
      default:
    }
  }

  async apply() {
    const enabled = this.networkConfig.enabled ? true : false;
    switch (this.name) {
      case "pptp": {
        if (enabled) {
          await exec("sudo modprobe ip_nat_pptp").catch((err) => {}); // this will load nf_nat_pptp and nf_conntrack_pptp
          await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p gre -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p tcp -m tcp --dport 1723 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p gre -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p tcp -m tcp --dport 1723 -j DROP")}`).catch((err) => {});
        } else {
          await exec("sudo rmmod nf_nat_pptp").catch((err) => {});
          await exec("sudo rmmod nf_conntrack_pptp").catch((err) => {});
          await exec(`${util.wrapIptables("sudo iptables -w -A FR_PASSTHROUGH -p gre -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo iptables -w -A FR_PASSTHROUGH -p tcp -m tcp --dport 1723 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -A FR_PASSTHROUGH -p gre -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -A FR_PASSTHROUGH -p tcp -m tcp --dport 1723 -j DROP")}`).catch((err) => {});
        }
        break;
      }
      case "l2tp": {
        if (enabled) {
          await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p udp -m udp --dport 1701 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p udp -m udp --dport 1701 -j DROP")}`).catch((err) => {});
        } else {
          await exec(`${util.wrapIptables("sudo iptables -w -A FR_PASSTHROUGH -p udp -m udp --dport 1701 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -A FR_PASSTHROUGH -p udp -m udp --dport 1701 -j DROP")}`).catch((err) => {});
        }
        break;
      }
      case "ipsec": {
        if (enabled) {
          await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p udp -m udp --dport 4500 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo iptables -w -D FR_PASSTHROUGH -p udp -m udp --dport 500 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p udp -m udp --dport 4500 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -D FR_PASSTHROUGH -p udp -m udp --dport 500 -j DROP")}`).catch((err) => {});
        } else {
          await exec(`${util.wrapIptables("sudo iptables -w -A FR_PASSTHROUGH -p udp -m udp --dport 4500 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo iptables -w -A FR_PASSTHROUGH -p udp -m udp --dport 500 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -A FR_PASSTHROUGH -p udp -m udp --dport 4500 -j DROP")}`).catch((err) => {});
          await exec(`${util.wrapIptables("sudo ip6tables -w -A FR_PASSTHROUGH -p udp -m udp --dport 500 -j DROP")}`).catch((err) => {});
        }
        break;
      }
      case "h323": {
        if (enabled) {
          await exec("sudo modprobe ip_nat_h323").catch((err) => {}); // this will load nf_nat_h323 and nf_conntrack_h323
        } else {
          await exec("sudo rmmod nf_nat_h323").catch((err) => {});
          await exec("sudo rmmod nf_conntrack_h323").catch((err) => {});
        }
        break;
      }
      case "sip": {
        if (enabled) {
          await exec("sudo modprobe ip_nat_sip").catch((err) => {}); // this will load nf_nat_sip and nf_conntrack_sip
        } else {
          await exec("sudo rmmod nf_nat_sip").catch((err) => {});
          await exec("sudo rmmod nf_conntrack_sip").catch((err) => {});
        }
        break;
      }
      default:
    }
  }
}

module.exports = NATPassthroughPlugin;