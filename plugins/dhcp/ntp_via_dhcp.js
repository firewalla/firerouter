/*    Copyright 2026 Firewalla Inc
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

// Applying the NTP servers announced by a DHCP server is done by a dhclient exit hook, which needs
// to be installed once and reconciled against the config on every setup. Both halves need to agree
// on where the hook lives, what it is called and where it keeps its state, so they live here.
//
// Whether an interface may use what its DHCP server announced is decided neither here nor in the
// generated dhclient.conf - some servers announce ntp-servers whether they were asked to or not -
// but in dhclient-script, which hides the announced servers from the hooks unless the interface
// was started with fr_allow_ntp=1. See _getDHClientEnvPath() in intf_base_plugin.js.

'use strict'

const log = require('../../util/logger.js')(__filename);
const r = require('../../util/firerouter.js');
const fs = require('fs');
const fsp = require('fs').promises;
const platform = require('../../platform/PlatformLoader.js').getPlatform();

const { exec, execFile } = require('child-process-promise');

const DHCLIENT_EXIT_HOOKS_DIR = "/etc/dhcp/dhclient-exit-hooks.d";
// hooks that feed the NTP servers announced by the DHCP server to a local time daemon, only the
// one of the daemon actually in use may be installed, two of them would fight over the clock
const NTP_DHCLIENT_HOOKS = ["ntp", "ntpdate", "timesyncd", "chrony"];
// where the hooks keep the servers learnt from each interface, keyed by time daemon
const NTP_DHCP_SOURCE_DIRS = {"ntp": "/run/ntp-dhcp", "chrony": "/run/chrony-dhcp"};
const SOURCES_SUFFIX = ".sources";
// interface names are interpolated into the shell commands below
const INTF_NAME_REGEX = /^[A-Za-z0-9_.-]+$/;

function getHookPath(serviceName) {
  return `${r.getFireRouterHome()}/scripts/dhclient_hooks/${serviceName}`;
}

// interfaces whose dhclient is allowed to feed the NTP servers it learns to the time daemon
function getAllowedInterfaces(config) {
  const interfaces = [];
  for (const ifaces of Object.values(config && config.interface || {})) {
    for (const name of Object.keys(ifaces || {})) {
      const ifaceConfig = ifaces[name];
      if (ifaceConfig && ifaceConfig.enabled && ifaceConfig.dhcp && ifaceConfig.allowNTPviaDHCP === true)
        interfaces.push(name);
    }
  }
  return interfaces;
}

// FireRouter ships its own version of the hook, the stock one drops every server, peer and pool
// line of /etc/ntp.conf, local clock fallback included, and keeps no per interface state. An apt
// upgrade of the ntp or systemd package puts the stock ones back, so reinstall unconditionally -
// a hook stays inert for every interface that did not opt in, so there is nothing to gate here.
async function installHook() {
  const serviceName = platform.getNtpServiceName();
  const srcPath = getHookPath(serviceName);
  if (!serviceName || !fs.existsSync(srcPath)) {
    log.error(`No dhclient exit hook available for NTP service ${serviceName}, NTP via DHCP will not take effect`);
    return;
  }
  await execFile("sudo", ["rm", "-f"].concat(NTP_DHCLIENT_HOOKS.filter(name => name !== serviceName).map(name => `${DHCLIENT_EXIT_HOOKS_DIR}/${name}`))).catch((err) => {
    log.error("Failed to remove unused NTP dhclient exit hooks", err.message);
  });
  await execFile("sudo", ["cp", srcPath, `${DHCLIENT_EXIT_HOOKS_DIR}/${serviceName}`]).catch((err) => {
    log.error(`Failed to copy dhclient exit hook for NTP service ${serviceName}`, err.message);
  });
}

// Revoke the NTP servers learnt from interfaces that no longer allow it. dhclient is stopped with
// SIGTERM and does not run the exit hooks on teardown, so a removed or disabled interface would
// otherwise keep feeding the time daemon its NTP servers until the box reboots - /run survives a
// service restart, and /etc/init.d/ntp keeps picking up a stale /run/ntp.conf.dhcp. An interface
// that merely turns the option off needs nothing from here, its dhclient is restarted with
// fr_allow_ntp=0 and the hook revokes it on the next lease event. Reconciling against the whole
// config also cleans up leftovers from a crash or from a version that did not do this at all.
// Must run after pl.reapply(), which is what restarts those dhclients.
async function reconcile(config) {
  const allowed = getAllowedInterfaces(config);
  for (const serviceName of Object.keys(NTP_DHCP_SOURCE_DIRS)) {
    const sourceDir = NTP_DHCP_SOURCE_DIRS[serviceName];
    const files = await fsp.readdir(sourceDir).catch((err) => []);
    const stale = files.filter(file => file.endsWith(SOURCES_SUFFIX))
      .map(file => file.slice(0, -SOURCES_SUFFIX.length))
      .filter(intf => INTF_NAME_REGEX.test(intf) && !allowed.includes(intf));
    if (stale.length === 0)
      continue;
    log.info(`Revoking NTP servers learnt via DHCP from ${stale.join(", ")}`);
    // drop them all at once and refresh the time daemon a single time, sourcing the hook once per
    // interface the way a lease event does would restart the daemon once per interface
    await execFile("sudo", ["rm", "-f"].concat(stale.map(intf => `${sourceDir}/${intf}${SOURCES_SUFFIX}`))).catch((err) => {
      log.error(`Failed to drop stale NTP servers of ${stale.join(", ")}`, err.message);
    });
    // with no interface in the environment - sudo scrubs it - sourcing the hook only defines its
    // functions, the reload can then be called on its own. Run the copy in the repo rather than
    // the installed one, which an apt upgrade may have replaced with the stock version.
    await exec(`sudo sh -c '. ${getHookPath(serviceName)}; ntp_dhcp_reload'`).catch((err) => {
      log.error(`Failed to reload ${serviceName} after revoking NTP servers`, err.message);
    });
  }
}

module.exports = {
  installHook: installHook,
  reconcile: reconcile
};
