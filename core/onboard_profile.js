/*    Copyright 2016-2026 Firewalla Inc.
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

// Expands the compact onboard "network profile" into a full FireRouter network config.
//
// The cloud cannot know how many ports a box has, so for the "adaptive" profile it only states the
// WAN connection method and the LAN subnet, and the box fills in the ports at boot: the installer's
// WAN port is always eth0 (pinned to its MAC by crystal-ifmap on every boot, see the installer's
// lib/ifmap.sh), and every other ethernet port joins the LAN bridge.
//
// Compact form:
//   { "profile": "adaptive",
//     "wan": { "type": "dhcp" }
//        | { "type": "pppoe", "username": "user@isp", "password": "secret" }
//        | { "type": "static", "ip": ..., "mask": ..., "gateway": ..., "dns": ... },
//     "lan": { "ip": "192.168.49.1", "mask": "255.255.255.0" } }

const _ = require('lodash');

const PROFILE_ADAPTIVE = "adaptive";
const WAN_PHY = "eth0";          // crystal-ifmap guarantees this is the installer's WAN port
const PPPOE_INTF = "ppp0";
const LAN_BRIDGE = "br0";
const ETH_NAME = /^eth\d+$/;     // wlan/usb interfaces are owned by other plugins, never bridged here
const DHCP_LEASE = 86400;

function ipToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4)
    return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255 || !/^\d+$/.test(p))
      return null;
    n = n * 256 + o;
  }
  return n;
}

function intToIp(n) {
  return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join(".");
}

// "255.255.255.0" -> 24, null if the mask is not a valid contiguous netmask
function maskToPrefix(mask) {
  const n = ipToInt(mask);
  if (n === null)
    return null;
  // a netmask is a run of ones followed by a run of zeros: ~n + 1 must be a power of two
  const inverted = (~n >>> 0) + 1;
  if (inverted !== 0 && (inverted & (inverted - 1)) !== 0)
    return null;
  let prefix = 0;
  for (let i = 31; i >= 0 && (n & (1 << i)); i--)
    prefix++;
  return prefix;
}

function toCidr(ip, mask, label) {
  const prefix = maskToPrefix(mask);
  if (ipToInt(ip) === null)
    throw new Error(`${label} ip is not a valid IPv4 address: ${ip}`);
  if (prefix === null)
    throw new Error(`${label} mask is not a valid netmask: ${mask}`);
  return `${ip}/${prefix}`;
}

// dns may be a single address, a comma separated list, or an array
function toNameservers(dns) {
  if (_.isArray(dns))
    return dns.filter(d => _.isString(d) && d.length > 0);
  if (_.isString(dns))
    return dns.split(",").map(d => d.trim()).filter(d => d.length > 0);
  return [];
}

// Usable DHCP pool inside the LAN subnet, keeping the low addresses free for static assignments.
// Mirrors the stock 10.10.0.10-10.10.0.250 layout of network/default_setup.json for a /24.
function dhcpRange(lanIp, prefix) {
  const ip = ipToInt(lanIp);
  const size = 2 ** (32 - prefix);
  const network = ip - (ip % size);
  const broadcast = network + size - 1;
  const from = network + 10;
  const to = broadcast - 5;
  if (from >= to)
    throw new Error(`lan subnet /${prefix} is too small to hand out a DHCP range`);
  return {from: intToIp(from), to: intToIp(to)};
}

function buildWan(wan) {
  const type = _.get(wan, "type");
  switch (type) {
    case "dhcp":
      return {
        wanIntf: WAN_PHY,
        phy: {meta: {name: "WAN", type: "wan"}, enabled: true, dhcp: true}
      };
    case "static": {
      const nameservers = toNameservers(wan.dns);
      if (ipToInt(wan.gateway) === null)
        throw new Error(`wan gateway is not a valid IPv4 address: ${wan.gateway}`);
      if (_.isEmpty(nameservers))
        throw new Error("wan dns is required for a static wan");
      return {
        wanIntf: WAN_PHY,
        phy: {
          meta: {name: "WAN", type: "wan"},
          enabled: true,
          ipv4: toCidr(wan.ip, wan.mask, "wan"),
          gateway: wan.gateway,
          nameservers
        }
      };
    }
    case "pppoe":
      if (!_.isString(wan.username) || !_.isString(wan.password) || !wan.username || !wan.password)
        throw new Error("wan username and password are required for pppoe");
      // The WAN is the ppp interface riding on eth0, so eth0 itself stays a plain enabled port:
      // it carries no address and must not be marked as the wan (see pppoe_intf_plugin.js).
      return {
        wanIntf: PPPOE_INTF,
        phy: {enabled: true},
        pppoe: {
          [PPPOE_INTF]: {
            meta: {name: "WAN", type: "wan"},
            enabled: true,
            intf: WAN_PHY,
            username: wan.username,
            password: wan.password
          }
        }
      };
    default:
      throw new Error(`unsupported wan type: ${type}`);
  }
}

// network: the compact block from onboard-config.json
// phyNames: physical interface names present on this box, e.g. from getPhyInterfaceNames()
function expandProfile(network, phyNames) {
  const profile = _.get(network, "profile");
  if (profile !== PROFILE_ADAPTIVE)
    throw new Error(`unsupported network profile: ${profile}`);

  // numeric order, so a 10+ port box lists eth2 before eth10
  const ethIndex = (n) => Number(n.slice(3));
  const eths = (phyNames || []).filter(n => ETH_NAME.test(n)).sort((a, b) => ethIndex(a) - ethIndex(b));
  if (!eths.includes(WAN_PHY))
    throw new Error(`${WAN_PHY} is not present, cannot tell which port is the wan`);

  const lan = _.get(network, "lan") || {};
  const lanCidr = toCidr(lan.ip, lan.mask, "lan");
  const lanPrefix = maskToPrefix(lan.mask);
  const {wanIntf, phy, pppoe} = buildWan(_.get(network, "wan"));

  // Every port that is not the wan is a LAN member — that is what "adaptive" means.
  const lanIntfs = eths.filter(n => n !== WAN_PHY);
  const phyConfigs = {[WAN_PHY]: phy};
  for (const intf of lanIntfs)
    phyConfigs[intf] = {enabled: true};

  const config = {
    interface: {
      phy: phyConfigs,
      bridge: {
        [LAN_BRIDGE]: {
          meta: {name: "LAN", type: "lan"},
          enabled: true,
          ipv4: lanCidr,
          intf: lanIntfs
        }
      }
    },
    routing: {global: {default: {viaIntf: wanIntf}}},
    dns: {
      default: {useNameserversFromWAN: true},
      [LAN_BRIDGE]: {useNameserversFromWAN: true}
    },
    nat: {
      [`${LAN_BRIDGE}_${wanIntf}`]: {in: LAN_BRIDGE, out: wanIntf}
    },
    dhcp: {
      [LAN_BRIDGE]: {
        gateway: lan.ip,
        subnetMask: lan.mask,
        nameservers: [lan.ip],
        searchDomain: [".lan"],
        range: dhcpRange(lan.ip, lanPrefix),
        lease: DHCP_LEASE
      }
    },
    // ssh on the wan as well, matching the stock Crystal onboard config: an adaptive box is
    // remotely supported and the wan side is the only way in before the LAN is wired up
    sshd: {
      [WAN_PHY]: {enabled: true},
      [LAN_BRIDGE]: {enabled: true}
    }
  };
  if (pppoe)
    config.interface.pppoe = pppoe;
  return config;
}

function isProfileConfig(network) {
  return _.isObject(network) && _.isString(network.profile);
}

module.exports = {
  expandProfile,
  isProfileConfig,
  maskToPrefix,
  PROFILE_ADAPTIVE,
  WAN_PHY
};
