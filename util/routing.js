/*    Copyright 2019-2026 Firewalla Inc.
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

const log = require('./logger.js')(__filename);

const { exec, execFile } = require('child-process-promise');
const fsp = require('fs').promises;
const _ = require('lodash');
const AsyncLock = require('async-lock');
const lock = new AsyncLock();

const RT_GLOBAL_LOCAL="global_local";
const RT_GLOBAL_DEFAULT = "global_default";
const RT_STATIC = "static";
const RT_WAN_ROUTABLE = "wan_routable";
const RT_LAN_ROUTABLE = "lan_routable";
const RT_MAIN = "main";

const RT_TYPE_VC = "RT_TYPE_VC";
const RT_TYPE_REG = "RT_TYPE_REG";
const MASK_REG = "0x1ff";
const MASK_VC = "0xfc00";
const MASK_ALL = "0xffff";

const LOCK_RT_TABLES = "LOCK_RT_TABLES";
const LOCK_FILE = "/tmp/rt_tables.lock";

// the table name is interpolated into a command line that is run by root, reject anything that is
// not a plain name so it cannot end the quoting or start a command substitution. the set is the
// one INTF_NAME_REGEX allows, since most table names are built from an interface name - ':' and
// '@' are inert both in the sed address and inside the double quotes of the append script.
// keep this in step with extension/routing/routing.js in firewalla. that copy also memoises table
// ids in an rtIdCache; leaving it out here is deliberate, not drift, so do not port it across.
function isValidTableName(tableName) {
  return _.isString(tableName) && tableName.length > 0 && !/[^A-Za-z0-9._:@-]/.test(tableName);
}

async function removeCustomizedRoutingTable(tableName) {
  if (!isValidTableName(tableName)) {
    log.error(`Invalid routing table name: ${tableName}`);
    throw new Error(`Invalid routing table name: ${tableName}`);
  }
  // the name goes into a sed address, where it is a regex rather than a literal. '.' is the only
  // character isValidTableName admits that a basic regular expression treats specially, so escape
  // it - without this, removing eth0.100_local would take eth0X100_local with it. widening the
  // allowlist above means revisiting this line.
  const pattern = tableName.replace(/\./g, '\\.');
  await execFile('sudo', ['flock', LOCK_FILE, 'sed', '-i', '-e',
    `/^[[:digit:]]\\+\\s\\+${pattern}$/d`, '/etc/iproute2/rt_tables']);
}

async function createCustomizedRoutingTable(tableName, type = RT_TYPE_REG) {
  if (!isValidTableName(tableName)) {
    log.error(`Invalid routing table name: ${tableName}`);
    throw new Error(`Invalid routing table name: ${tableName}`);
  }
  return new Promise((resolve, reject) => {
    // async-lock takes this as a callback-style task because of the done argument, so the promise it
    // returns is discarded: a throw or a rejected await would never release the lock and would leave
    // the outer promise pending for good, since this lock has no timeout. every path ends in done()
    lock.acquire(LOCK_RT_TABLES, async function(done) {
      try {
        // separate bits in fwmark for vpn client and regular WAN
        const bitOffset = type === RT_TYPE_VC ? 10 : 0;
        const maxTableId = type === RT_TYPE_VC ? 64 : 512;
        // an unreadable rt_tables has to fail the call: with no content every id looks free and the
        // loop below would hand out one that is already in use
        const content = await fsp.readFile('/etc/iproute2/rt_tables', 'utf8');
        const usedTid = [];
        for (const entry of content.split('\n')) {
          // a comment can follow an entry, so drop the whole line if it holds a '#' at all, then
          // take the id and the name from the first two fields
          if (entry.includes('#')) continue;
          const line = entry.trim().split(/\s+/);
          const tid = line[0];
          const name = line[1];
          if (!tid) continue;
          usedTid.push(tid);
          if (name === tableName) {
            if (Number(tid) >>> bitOffset === 0 || Number(tid) >>> bitOffset >= maxTableId) {
              log.info(`Previous table id of ${tableName} is out of range ${tid}, removing old entry for ${tableName} ...`);
              await removeCustomizedRoutingTable(tableName);
            } else {
              log.debug("Table with same name already exists: " + tid);
              done(null, Number(tid));
              return;
            }
          }
        }
        // find unoccupied table id between 1 - maxTableId
        let id = 1;
        while (id < maxTableId) {
          if (!usedTid.includes((id << bitOffset) + "")) // convert number to string
            break;
          id++;
        }
        if (id == maxTableId) {
          done(`Insufficient space to create routing table for ${tableName}, type ${type}`, null);
          return;
        }
        // the redirections and the pipeline need a shell, so flock is given bash directly instead of
        // being wrapped in one. bash is named rather than using flock's own -c, which picks $SHELL
        // and falls back to /bin/sh, where the builtin echo has no -e and would emit a literal "-e"
        const script = `echo -e "${id << bitOffset}\\t${tableName}" >> /etc/iproute2/rt_tables; \
        cat /etc/iproute2/rt_tables | sort | uniq > /etc/iproute2/rt_tables.new; \
        cp /etc/iproute2/rt_tables.new /etc/iproute2/rt_tables; \
        rm /etc/iproute2/rt_tables.new`;
        log.info("Append new routing table: ", script);
        const result = await execFile('sudo', ['flock', LOCK_FILE, 'bash', '-c', script]);
        if (result.stderr !== "") {
          log.error("Failed to create customized routing table.", result.stderr);
          done(result.stderr, null);
          return;
        }
        done(null, id << bitOffset);
      } catch (err) {
        log.error(`Failed to create routing table ${tableName}`, err.message);
        done(err, null);
      }
    }, function(err, ret) {
      if (err)
        reject(err);
      else
        resolve(ret);
    });
  });
}

async function createPolicyRoutingRule(from, iif, tableName, priority, fwmark, af = 4) {
  from = from || "all";
  let rule = `from ${from} `;
  if (fwmark) {
    if (_.isString(fwmark) && fwmark.includes("/")) {
      const mark = Number(fwmark.split("/")[0]).toString(16);
      const mask = Number(fwmark.split("/")[1]).toString(16);
      rule = `${rule}fwmark 0x${mark}/0x${mask} `;
    } else {
      const mark = Number(fwmark).toString(16);
      rule = `${rule}fwmark 0x${mark} `;
    }
  }
  if (iif && iif !== "")
    rule = `${rule}iif ${iif} `;
  rule = `${rule}lookup ${tableName}`;
  if (priority)
    rule = `${rule} priority ${priority}`;
  const cmd = `sudo ip -${af} rule add ${rule}`;
  log.info("Create new policy routing rule: ", cmd);
  await exec(cmd).catch((err) => {
    if (err.message.includes("File exists")) {
      log.debug("Same policy routing rule already exists: ", rule);
      return;
    }
    log.error("Failed to create policy routing rule.", err.message);
    throw err;
  });
}

async function removePolicyRoutingRule(from, iif, tableName, priority, fwmark, af = 4) {
  from = from || "all";
  let rule = `from ${from} `;
  if (fwmark) {
    if (_.isString(fwmark) && fwmark.includes("/")) {
      const mark = Number(fwmark.split("/")[0]).toString(16);
      const mask = Number(fwmark.split("/")[1]).toString(16);
      rule = `${rule}fwmark 0x${mark}/0x${mask} `;
    } else {
      const mark = Number(fwmark).toString(16);
      rule = `${rule}fwmark 0x${mark} `;
    }
  }
  if (iif && iif !== "")
    rule = `${rule}iif ${iif} `;
  rule = `${rule}lookup ${tableName}`;
  if (priority)
    rule = `${rule} priority ${priority}`;
  const cmd = `sudo ip -${af} rule del ${rule}`;
  log.info("Remove policy routing rule: ", cmd);
  await exec(cmd).catch((err) => {
    if (err.message.includes("No such file or directory")) {
      log.debug("Policy routing rule does not exist: ", rule);
      return;
    }
    log.error("Failed to remove policy routing rule.", err.message);
    throw err;
  });
}

async function addRouteToTable(dest, gateway, intf, tableName, preference, af = 4, replace = false, type = "unicast") {
  dest = dest || "default";
  // pass argv explicitly, dest/gateway/intf/tableName come from network config and must not reach a shell
  const args = ["ip", `-${af}`, "route", replace ? 'replace' : 'add', type, String(dest)];
  tableName = tableName || "main";
  if (intf) {
    if (gateway) {
      args.push("via", String(gateway), "dev", String(intf));
    } else {
      args.push("dev", String(intf));
    }
  }
  args.push("table", String(tableName));
  if (preference)
    args.push("preference", String(preference));

  log.debug('[routing] add route to table:', args.join(' '));
  let result = await execFile("sudo", args);
  if (result.stderr !== "") {
    log.error("Failed to add route to table.", result.stderr);
    throw result.stderr;
  }
}

function formatGetRouteCommand(dest, gateway, intf, tableName, metric, af=4) {
  let cmd=`ip -${af} route show`;
  if (tableName) {
    cmd += ` table ${tableName}`
  }
  if (dest) {
    cmd += ` ${dest}`
  }
  if (intf) {
    cmd += ` dev ${intf}`
  }
  if (gateway) {
    cmd += ` via ${gateway}`
  }
  if (metric) {
    cmd += ` metric ${metric}`
  }
  return cmd;
}

async function searchRouteRules(dest, gateway, intf, tableName, metric=null, af=4) {
  tableName = tableName || "main";
  const cmd = formatGetRouteCommand(dest, gateway, intf, tableName, metric, af);
  const result = await exec(cmd).then(r => r.stdout.trim()).catch((err) => {log.info(`Failed to get route using command '${cmd}'`, err.stderr); return "";});

  return result.split("\n").filter(r => r.length > 0).map(r => r.trim());
}

async function removeDeviceRouteRule(intf, tableName, af = 4) {
  const args = [`-${af}`, "route", "flush", "table", tableName, "dev", intf];
  log.debug('[routing] flush device route rule:', "sudo ip", args.join(" "));
  const result = await execFile("sudo", ["ip"].concat(args));
  if (result.stderr !== "") {
    log.error(`Failed to exec sudo ip ${args.join(" ")}, err`, result.stderr);
    throw result.stderr;
  }
}

async function addMultiPathRouteToTable(dest, tableName, af = 4, metric, ...multipathDesc) {
  dest = dest || "default";
  // pass argv explicitly, weight comes straight from the nextHops config and must not reach a shell
  const args = ["ip", `-${af}`, "route", "add", String(dest)];
  tableName = tableName || "main";
  args.push("table", String(tableName), "metric", String(metric));
  for (let desc of multipathDesc) {
    const nextHop = desc.nextHop;
    const dev = desc.dev;
    const weight = Number(desc.weight);
    if (!nextHop || !Number.isInteger(weight) || weight < 1 || weight > 255) {
      if (desc.weight !== undefined && !Number.isInteger(weight))
        log.error("Invalid nextHop weight, skip", desc.weight);
      continue;
    }
    args.push("nexthop", "via", String(nextHop));
    if (dev)
      args.push("dev", String(dev));
    args.push("weight", String(weight));
  }
  log.debug('[routing] add multipath route to table:', args.join(' '));
  let result = await execFile("sudo", args);
  if (result.stderr !== "") {
    log.error("Failed to add multipath route to table.", result.stderr);
    throw result.stderr
  }
}

async function removeRouteFromTable(dest, gateway, intf, tableName, af = 4, type = "unicast", metric = null) {
  dest = dest || "default";
  tableName = tableName || "main";
  let cmd = `sudo ip -${af} route del ${type} ${dest}`;
  if (gateway) {
    cmd = `${cmd} via ${gateway}`;
  }
  if (intf) {
    cmd = `${cmd} dev ${intf}`;
  }
  if (metric) {
    cmd = `${cmd} metric ${metric}`;
  }
  cmd = `${cmd} table ${tableName}`;

  log.debug(`[routing] remove route from table: ${cmd}`);
  let result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to remove route from table.", result.stderr);
    throw result.stderr;
  }
}

async function flushRoutingTable(tableName, af = null) {
  const cmds = [];
  if (!af || af == 4)
    cmds.push(["ip", "route", "flush", "table", tableName]);
  if (!af || af == 6)
    cmds.push(["ip", "-6", "route", "flush", "table", tableName]);
  for (const cmd of cmds) {
    log.debug(`[routing] flush route table: sudo ${cmd.join(" ")}`);
    await execFile("sudo", cmd).catch((err) => {
      log.debug(`Failed to flush routing table using command sudo ${cmd.join(" ")}`, err.message);
    });
  }
}

async function flushPolicyRoutingRules() {
  const cmds = [["ip", "rule", "flush"], ["ip", "-6", "rule", "flush"]];
  for (const cmd of cmds) {
    let result = await execFile("sudo", cmd);
    if (result.stderr !== "") {
      log.error("Failed to flush policy routing rules.", result.stderr);
      throw result.stderr;
    }
  }
}

async function initializeInterfaceRoutingTables(intf) {
  await createCustomizedRoutingTable(`${intf}_local`);
  await createCustomizedRoutingTable(`${intf}_default`);
  await flushRoutingTable(`${intf}_local`);
  await flushRoutingTable(`${intf}_default`);
}

async function createInterfaceRoutingRules(intf, noSelfRoute = false, isWan = false) {
  // self route on specific types of WAN interface may be undesired and will cause infinite loop, e.g., docker network with VPN client containers
  const promises = [
    createPolicyRoutingRule("all", intf, `${intf}_local`, 501),
    // lookup wan local routing table for local-originated packet only if mark is not explicitly set
    createPolicyRoutingRule("all", "lo", `${intf}_local`, 501, isWan ? `0x0/${MASK_REG}` : null),
    createPolicyRoutingRule("all", intf, `${intf}_local`, 501, null, 6),
    createPolicyRoutingRule("all", "lo", `${intf}_local`, 501, isWan ? `0x0/${MASK_REG}` : null, 6),
  ];
  if (!noSelfRoute) {
    promises.push(createPolicyRoutingRule("all", intf, `${intf}_default`, 8001));
    promises.push(createPolicyRoutingRule("all", intf, `${intf}_default`, 8001, null, 6));
  }
  await Promise.all(promises);
}

async function removeInterfaceRoutingRules(intf) {
  const promises = [
    removePolicyRoutingRule("all", intf, `${intf}_local`, 501),
    removePolicyRoutingRule("all", "lo", `${intf}_local`, 501),
    removePolicyRoutingRule("all", intf, `${intf}_default`, 8001),
    removePolicyRoutingRule("all", intf, `${intf}_local`, 501, null, 6),
    removePolicyRoutingRule("all", "lo", `${intf}_local`, 501, null, 6),
    removePolicyRoutingRule("all", intf, `${intf}_default`, 8001, null, 6),
  ];
  await Promise.all(promises);
}

async function createInterfaceGlobalRoutingRules(intf) {
  await createPolicyRoutingRule("all", intf, RT_GLOBAL_DEFAULT, 10001);
  await createPolicyRoutingRule("all", intf, RT_GLOBAL_DEFAULT, 10001, null, 6);
}

async function removeInterfaceGlobalRoutingRules(intf) {
  await removePolicyRoutingRule("all", intf, RT_GLOBAL_DEFAULT, 10001).catch((err) => {});
  await removePolicyRoutingRule("all", intf, RT_GLOBAL_DEFAULT, 10001, null, 6).catch((err) => {});
}

async function createInterfaceGlobalLocalRoutingRules(intf) {
  await createPolicyRoutingRule("all", intf, RT_GLOBAL_LOCAL, 3000);
  await createPolicyRoutingRule("all", intf, RT_GLOBAL_LOCAL, 3000, null, 6);
}

async function removeInterfaceGlobalLocalRoutingRules(intf) {
  await removePolicyRoutingRule("all", intf, RT_GLOBAL_LOCAL, 3000).catch((err) => {});
  await removePolicyRoutingRule("all", intf, RT_GLOBAL_LOCAL, 3000, null, 6).catch((err) => {});
}

async function getInterfaceGWIP(intf, af = 4) {
  const nextHop = await exec(`ip -${af} r show table ${intf}_default | grep "^default via" | awk '{print $3}'`).then((result) => result.stdout.trim()).catch((err) => {return null;});
  return nextHop;
}

module.exports = {
  isValidTableName,
  createCustomizedRoutingTable: createCustomizedRoutingTable,
  removeCustomizedRoutingTable: removeCustomizedRoutingTable,
  createPolicyRoutingRule: createPolicyRoutingRule,
  removePolicyRoutingRule: removePolicyRoutingRule,
  addRouteToTable: addRouteToTable,
  removeRouteFromTable: removeRouteFromTable,
  addMultiPathRouteToTable: addMultiPathRouteToTable,
  flushRoutingTable: flushRoutingTable,
  flushPolicyRoutingRules: flushPolicyRoutingRules,
  initializeInterfaceRoutingTables: initializeInterfaceRoutingTables,
  createInterfaceRoutingRules: createInterfaceRoutingRules,
  removeInterfaceRoutingRules: removeInterfaceRoutingRules,
  createInterfaceGlobalRoutingRules: createInterfaceGlobalRoutingRules,
  removeInterfaceGlobalRoutingRules: removeInterfaceGlobalRoutingRules,
  createInterfaceGlobalLocalRoutingRules: createInterfaceGlobalLocalRoutingRules,
  removeInterfaceGlobalLocalRoutingRules: removeInterfaceGlobalLocalRoutingRules,
  getInterfaceGWIP: getInterfaceGWIP,
  searchRouteRules: searchRouteRules,
  formatGetRouteCommand: formatGetRouteCommand, // only for testing
  removeDeviceRouteRule: removeDeviceRouteRule,
  RT_GLOBAL_LOCAL: RT_GLOBAL_LOCAL,
  RT_GLOBAL_DEFAULT: RT_GLOBAL_DEFAULT,
  RT_WAN_ROUTABLE: RT_WAN_ROUTABLE,
  RT_LAN_ROUTABLE: RT_LAN_ROUTABLE,
  RT_MAIN: RT_MAIN,
  RT_STATIC: RT_STATIC,
  RT_TYPE_REG,
  RT_TYPE_VC,
  MASK_REG,
  MASK_VC,
  MASK_ALL
}