/*    Copyright 2019 - 2020 Firewalla Inc
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

const exec = require('child-process-promise').exec;
const _ = require('lodash');

const RT_GLOBAL_LOCAL="global_local";
const RT_GLOBAL_DEFAULT = "global_default";
const RT_STATIC = "static";
const RT_WAN_ROUTABLE = "wan_routable";
const RT_LAN_ROUTABLE = "lan_routable";

async function createCustomizedRoutingTable(tableName) {
  let cmd = "cat /etc/iproute2/rt_tables | grep -v '#' | awk '{print $1,\"\\011\",$2}'";
  let result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to read rt_tables.", result.stderr);
  }
  const entries = result.stdout.split('\n');
  const usedTid = [];
  for (var i in entries) {
    const entry = entries[i];
    const line = entry.split(/\s+/);
    const tid = line[0];
    const name = line[1];
    usedTid.push(tid);
    if (name === tableName) {
      log.debug("Table with same name already exists: " + tid);
      return Number(tid);
    }
  }
  // find unoccupied table id between 100-10000
  let id = 100;
  while (id < 10000) {
    if (!usedTid.includes(id + "")) // convert number to string
      break;
    id++;
  }
  if (id == 10000) {
    throw "Insufficient space to create routing table";
  }
  cmd = `sudo bash -c 'flock /tmp/rt_tables.lock -c "echo -e ${id}\\\t${tableName} >> /etc/iproute2/rt_tables; \
    cat /etc/iproute2/rt_tables | sort | uniq > /etc/iproute2/rt_tables.new; \
    cp /etc/iproute2/rt_tables.new /etc/iproute2/rt_tables; \
    rm /etc/iproute2/rt_tables.new"'`;
  log.info("Append new routing table: ", cmd);
  result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to create customized routing table.", result.stderr);
    throw result.stderr;
  }
  return id;
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
  let cmd = `ip -${af} rule list ${rule}`;
  let result = await exec(cmd).then(r => r.stdout).catch((err) => {
    log.debug(`Failed to list rule with command ${cmd}`, err.message);
    return "";
  });
  if (result.length > 0) {
    log.debug("Same policy routing rule already exists: ", rule);
    return;
  }
  cmd = `sudo ip -${af} rule add ${rule}`;
  log.info("Create new policy routing rule: ", cmd);
  result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to create policy routing rule.", result.stderr);
    throw result.stderr;
  }
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
  let cmd = `ip -${af} rule list ${rule}`;
  let result = await exec(cmd).then(r => r.stdout).catch((err) => {
    log.debug(`Failed to list rule with command ${cmd}`, err.message);
    return "";
  });
  if (result.length === 0) {
    log.debug("Policy routing rule does not exist: ", rule);
    return;
  }
  cmd = `sudo ip -${af} rule del ${rule}`;
  log.info("Remove policy routing rule: ", cmd);
  result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to remove policy routing rule.", result.stderr);
    throw result.stderr;
  }
}

async function addRouteToTable(dest, gateway, intf, tableName, preference, af = 4, replace = false) {
  let cmd = null;
  dest = dest || "default";
  tableName = tableName || "main";
  if (gateway) {
    cmd = `sudo ip -${af} route ${replace ? 'replace' : 'add'} ${dest} via ${gateway} dev ${intf} table ${tableName}`;
  } else {
    cmd = `sudo ip -${af} route ${replace ? 'replace' : 'add'} ${dest} dev ${intf} table ${tableName}`;
  }
  if (preference)
    cmd = `${cmd} preference ${preference}`;
  let result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to add route to table.", result.stderr);
    throw result.stderr;
  }
}

async function addMultiPathRouteToTable(dest, tableName, af = 4, ...multipathDesc) {
  let cmd = null;
  dest = dest || "default";
  cmd =  `sudo ip -${af} route add ${dest}`;
  tableName = tableName || "main";
  cmd = `${cmd} table ${tableName}`;
  for (let desc of multipathDesc) {
    const nextHop = desc.nextHop;
    const dev = desc.dev;
    const weight = desc.weight;
    if (!nextHop || !weight)
      continue;
    cmd = `${cmd} nexthop via ${nextHop}`;
    if (dev)
      cmd = `${cmd} dev ${dev}`;
    cmd = `${cmd} weight ${weight}`;
  }
  let result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to add multipath route to table.", result.stderr);
    throw result.stderr
  }
}

async function removeRouteFromTable(dest, gateway, intf, tableName, af = 4) {
  let cmd = null;
  dest = dest || "default";
  tableName = tableName || "main";
  cmd = `sudo ip -${af} route del ${dest}`;
  if (gateway) {
    cmd = `${cmd} via ${gateway}`;
  }
  if (intf) {
    cmd = `${cmd} dev ${intf}`;
  }
  cmd = `${cmd} table ${tableName}`;
  let result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to remove route from table.", result.stderr);
    throw result.stderr;
  }
}

async function flushRoutingTable(tableName) {
  const cmds = [`sudo ip route flush table ${tableName}`, `sudo ip -6 route flush table ${tableName}`];
  for (const cmd of cmds) {
    let result = await exec(cmd);
    if (result.stderr !== "") {
      log.error("Failed to flush routing table.", result.stderr);
      throw result.stderr;
    }
  }
}

async function flushPolicyRoutingRules() {
  const cmds = [`sudo ip rule flush`, `sudo ip -6 rule flush`];
  for (const cmd of cmds) {
    let result = await exec(cmd);
    if (result.stderr !== "") {
      log.error("Failed to flush policy routing rules.", result.stderr);
      throw result.stderr;
    }
  }
}

async function initializeInterfaceRoutingTables(intf) {
  await createCustomizedRoutingTable(`${intf}_local`);
  await createCustomizedRoutingTable(`${intf}_static`);
  await createCustomizedRoutingTable(`${intf}_default`);
  await flushRoutingTable(`${intf}_local`);
  await flushRoutingTable(`${intf}_static`);
  await flushRoutingTable(`${intf}_default`);
}

async function createInterfaceRoutingRules(intf) {
  await createPolicyRoutingRule("all", intf, `${intf}_local`, 501);
  await createPolicyRoutingRule("all", intf, `${intf}_static`, 3001);
  await createPolicyRoutingRule("all", intf, `${intf}_default`, 8001);
  await createPolicyRoutingRule("all", intf, `${intf}_local`, 501, null, 6);
  await createPolicyRoutingRule("all", intf, `${intf}_static`, 3001, null, 6);
  await createPolicyRoutingRule("all", intf, `${intf}_default`, 8001, null, 6);
}

async function removeInterfaceRoutingRules(intf) {
  await removePolicyRoutingRule("all", intf, `${intf}_local`, 501).catch((err) => {});
  await removePolicyRoutingRule("all", intf,  `${intf}_static`, 3001).catch((err) => {});
  await removePolicyRoutingRule("all", intf, `${intf}_default`, 8001).catch((err) => {});
  await removePolicyRoutingRule("all", intf, `${intf}_local`, 501, null, 6).catch((err) => {});
  await removePolicyRoutingRule("all", intf,  `${intf}_static`, 3001, null, 6).catch((err) => {});
  await removePolicyRoutingRule("all", intf, `${intf}_default`, 8001, null, 6).catch((err) => {});
}

async function createInterfaceGlobalRoutingRules(intf) {
  await createPolicyRoutingRule("all", intf, RT_GLOBAL_DEFAULT, 10001);
  await createPolicyRoutingRule("all", intf, RT_GLOBAL_DEFAULT, 10001, null, 6);
}

async function removeInterfaceGlobalRoutingRules(intf) {
  await removePolicyRoutingRule("all", intf, RT_GLOBAL_DEFAULT, 10001).catch((err) => {});
  await removePolicyRoutingRule("all", intf, RT_GLOBAL_DEFAULT, 10001, null, 6).catch((err) => {});
}

async function getInterfaceGWIP(intf, af = 4) {
  const nextHop = await exec(`ip -${af} r show table ${intf}_default | grep default | awk '{print $3}'`).then((result) => result.stdout.trim()).catch((err) => {return null;});
  return nextHop;
}

module.exports = {
  createCustomizedRoutingTable: createCustomizedRoutingTable,
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
  getInterfaceGWIP: getInterfaceGWIP,
  RT_GLOBAL_LOCAL: RT_GLOBAL_LOCAL,
  RT_GLOBAL_DEFAULT: RT_GLOBAL_DEFAULT,
  RT_WAN_ROUTABLE: RT_WAN_ROUTABLE,
  RT_LAN_ROUTABLE: RT_LAN_ROUTABLE,
  RT_STATIC: RT_STATIC
}