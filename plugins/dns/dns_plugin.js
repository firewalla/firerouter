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

const _ = require('lodash');
const {Address4, Address6} = require('ip-address');
const Plugin = require('../plugin.js');
const pl = require('../plugin_loader.js');
const event = require('../../core/event.js');

const dnsServiceFileTemplate = __dirname + "/firerouter_dns.template.service";
const dnsScriptTemplate = __dirname + "/dns.template.sh";

const { exec, execFile } = require('child-process-promise');

const r = require('../../util/firerouter');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const log = require('../../util/logger.js')('DNSPlugin');

let _restartTask = null;

const dnsConfTemplate = r.getFireRouterHome() + "/etc/dnsmasq.dns.conf.template";

class DNSPlugin extends Plugin {

  static async preparePlugin() {
    await execFile("sudo", ["cp", "-f", `${r.getFireRouterHome()}/scripts/rsyslog.d/13-dnsmasq.conf`, "/etc/rsyslog.d/"]);
    await execFile("sudo", ["cp", "-f", `${r.getFireRouterHome()}/scripts/rsyslog.d/16-firerouter-dns.conf`, "/etc/rsyslog.d/"]);
    await this.createDirectories();
    await this.installDNSScript();
    await this.installSystemService();
    await this.cleanupLocalhostDnsConf();
  }

  // Find a dead localhost upstream in a scanned conf's content, given whether its port is
  // listening. Returns null when there's nothing to delete, otherwise the port and whether other
  // directives ride along in the same file.
  static _findDeadLocalhostUpstream(content, listening) {
    const match = content.match(/server=127\.0\.0\.1#(\d+)/);
    if (!match || listening) return null;
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    return { port: match[1], mixed: lines.length > 1 };
  }

  static _parseListeningPorts(ssOutput) {
    const ports = new Set();
    for (const line of ssOutput.split('\n')) {
      for (const token of line.trim().split(/\s+/)) {
        const matched = token.match(/:(\d+)$/);
        if (!matched) continue;
        ports.add(matched[1]);
        break;
      }
    }
    return ports;
  }

  // Remove localhost-upstream confs whose port isn't listening yet (boot gap guard).
  // Only runs once per boot via a /dev/shm marker; skipped on plain firerouter restarts
  static async cleanupLocalhostDnsConf() {
    const marker = '/dev/shm/firerouter_dns_boot_cleanup_done';
    const alreadyRun = await fs.accessAsync(marker).then(() => true).catch(() => false);
    if (alreadyRun) return;

    const confDir = `${r.getFirewallaUserConfigFolder()}/dnsmasq`;
    const { stdout } = await execFile("grep", ["-rl", "server=127\\.0\\.0\\.1#", confDir]).catch(() => ({ stdout: '' }));
    const confs = stdout.trim().split('\n').filter(Boolean);
    const { stdout: ssOutput } = await exec("ss -lntu").catch(() => ({ stdout: '' }));
    const listeningPorts = this._parseListeningPorts(ssOutput);
    for (const conf of confs) {
      const content = await fs.readFileAsync(conf, 'utf8').catch(() => '');
      const match = content.match(/server=127\.0\.0\.1#(\d+)/);
      if (!match) continue;
      const listening = listeningPorts.has(match[1]);
      const decision = this._findDeadLocalhostUpstream(content, listening);
      if (!decision) continue;
      if (decision.mixed)
        // deleting anyway per the dead-port rule, but flagged since other directives go with it.
        log.warn(`${conf} has a dead localhost upstream (port ${decision.port}) mixed with other directives, deleting the whole file - please check manually`);
      await fs.unlinkAsync(conf).catch(() => {});
    }

    await fs.writeFileAsync(marker, '').catch(() => {});
  }

  static async createDirectories() {
    await execFile("mkdir", ["-p", `${r.getUserConfigFolder()}/dnsmasq`]).catch((err) => {});
    await execFile("mkdir", ["-p", `${r.getRuntimeFolder()}/dnsmasq`]).catch((err) => {});
    await execFile("mkdir", ["-p", r.getTempFolder()]).catch((err) => {});
    await execFile("mkdir", ["-p", `${r.getFirewallaUserConfigFolder()}/dnsmasq_local`]).catch((err) => {});
  } 

  static async installSystemService() {
    let content = await fs.readFileAsync(dnsServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace(/%WORKING_DIRECTORY%/g, r.getFireRouterHome());
    content = content.replace(/%DNS_DIRECTORY%/g, r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_dns.service";
    await fs.writeFileAsync(targetFile, content);
    await execFile("sudo", ["cp", targetFile, "/etc/systemd/system"]);
  }

  static async installDNSScript() {
    let content = await fs.readFileAsync(dnsScriptTemplate, {encoding: 'utf8'});
    content = content.replace(/%FIREROUTER_HOME%/g, r.getFireRouterHome());
    const targetFile = r.getTempFolder() + "/dns.sh";
    await fs.writeFileAsync(targetFile, content);
  }

  async flush() {
    const confPath = this._getConfFilePath();
    await fs.unlinkAsync(confPath).catch((err) => {});
    await fs.unlinkAsync(this._getResolvFilePath()).catch((err) => {});
    // do not touch firewalla user config dnsmasq directory in flush()
    this._restartService();
  }

  _getConfFilePath() {
    return `${r.getFireRouterHome()}/etc/dnsmasq.dns.${this.name}.conf`;
  }

  _getResolvFilePath() {
    return `${r.getUserConfigFolder()}/dnsmasq/${this.name}.resolv.conf`;
  }

  async prepareEnvironment() {
    await execFile("mkdir", ["-p", `${r.getFirewallaUserConfigFolder()}/dnsmasq/${this._intfUuid}`]).catch((err) => {});
  }

  async _findWANWithNameservers(wanIntfPlugins, requireCarrier = false) {
    for (const wanIntfPlugin of wanIntfPlugins) {
      // fs.existsSync will return false if the (recursive) symlink points to a non-existing file
      if (!fs.existsSync(r.getInterfaceResolvConfPath(wanIntfPlugin.name)))
        continue;
      if (!await wanIntfPlugin.isInterfacePresent())
        continue;
      // isInterfacePresent only means the netdev is there, so an unplugged WAN passes it with the
      // nameservers of its last lease still in its resolv.conf
      if (requireCarrier && await wanIntfPlugin.carrierState() !== "1")
        continue;
      if (_.isEmpty(await wanIntfPlugin.getDNSNameservers()))
        continue;
      return wanIntfPlugin;
    }
    return null;
  }

  // a WAN that still has a carrier in any of the lists beats one without in all of them: the inUse
  // seq fallback and getAllWANPlugins() are both ordered by seq, which puts the (wired) primary
  // first even while it is down. Falling back to a WAN with no carrier keeps an upstream at all
  // when nothing is connected.
  async _findTentativeWAN(wanIntfPluginLists) {
    for (const requireCarrier of [true, false]) {
      for (const wanIntfPlugins of wanIntfPluginLists) {
        const intfPlugin = await this._findWANWithNameservers(wanIntfPlugins, requireCarrier);
        if (intfPlugin)
          return intfPlugin;
      }
    }
    return null;
  }

  // in load_balance a standby backup gets its DNS host routes removed and reinstalled with
  // dns: false (RoutingPlugin._applyBackupWanRoutes), so its nameservers would be queried over the
  // active WAN's default route instead of the backup, which fails for a resolver only the backup
  // can reach. primary_standby routes its backups through the same loop as every other WAN, which
  // keeps their DNS routes, so there they stay eligible.
  _isStandbyBackup(routingPlugin, intfPlugin) {
    if (_.get(routingPlugin, "networkConfig.default.type") !== "load_balance")
      return false;
    const state = routingPlugin.getWANConnState && routingPlugin.getWANConnState(intfPlugin.name);
    return Boolean(state && state.backup === true && state.active !== true);
  }

  // links the resolv.conf of the active WAN, or a tentative one while no WAN is active
  async _linkWANResolvConf(routingPlugin) {
    const wanIntfPlugins = routingPlugin.getActiveWANPlugins();
    const inUseWanIntfPlugins = routingPlugin.getInUseWANPlugins() || [];
    let intfPlugin = null;
    if (wanIntfPlugins && wanIntfPlugins.length > 0) {
      // an active WAN is only passed over when its resolv.conf has no nameserver at all: linking it
      // would leave dnsmasq with no upstream, which is worse than borrowing one from another WAN.
      // an active WAN without a carrier is still kept, so this never overrides the primary/standby
      // choice routing has made
      const borrowable = (plugins) => plugins.filter(p => !this._isStandbyBackup(routingPlugin, p));
      intfPlugin = await this._findTentativeWAN([wanIntfPlugins])
        || await this._findTentativeWAN([borrowable(inUseWanIntfPlugins), borrowable(routingPlugin.getAllWANPlugins() || [])])
        || wanIntfPlugins[0];
    } else if (inUseWanIntfPlugins.length > 0) {
      // use first connected WAN's name server as tentative upstream DNS nameserver, else any WAN's: a Wi-Fi WAN between
      // uplinks is not in use, while its resolv.conf already has the new uplink's nameservers
      intfPlugin = await this._findTentativeWAN([inUseWanIntfPlugins, routingPlugin.getAllWANPlugins() || []]);
      if (!intfPlugin) {
        this.log.error(`No connected WAN is found for dns ${this.name}, DNS is temporarily unavailable`);
        return;
      }
    } else {
      // use primary WAN's name server as tentative upstream DNS nameserver if no active WAN is available
      intfPlugin = await this._findTentativeWAN([routingPlugin.getAllWANPlugins() || []]) || routingPlugin.getPrimaryWANPlugin();
      if (!intfPlugin) {
        this.log.error(`No active WAN is found for dns ${this.name}, DNS is temporarily unavailable`);
        return;
      }
      this.log.error(`No active WAN is found for dns ${this.name}, tentatively choosing the WAN ${intfPlugin.name}`);
    }
    await fs.symlinkAsync(r.getInterfaceResolvConfPath(intfPlugin.name), this._getResolvFilePath());
  }

  async writeDNSConfFile() {
    let content = await fs.readFileAsync(dnsConfTemplate, {encoding: "utf8"});
    content = content.replace(/%INTERFACE%/g, this.name);
    content = content.replace(/%INTERFACE_UUID%/g, this._intfUuid);
    await fs.writeFileAsync(this._getConfFilePath(), content);

    await fs.unlinkAsync(this._getResolvFilePath()).catch((err) => {});
    if (this.networkConfig.nameservers || this.networkConfig.dns6Servers) {
      let dnsservers = this.networkConfig.nameservers || [];
      dnsservers = dnsservers.filter(i => new Address4(i).isValid());
      if (this.networkConfig.dns6Servers && _.isArray(this.networkConfig.dns6Servers))
        dnsservers = dnsservers.concat(this.networkConfig.dns6Servers.filter(i => new Address6(i).isValid()));
      if (dnsservers.length == 0) {
        this.fatal("Cannot find valid dns options for", this.name);
        return;
      }
      this.log.info("write dns conf file", this.name, dnsservers);
      const nameservers = _.uniq(dnsservers).map((n) => `nameserver ${n}`).join("\n") + "\n";
      await fs.writeFileAsync(this._getResolvFilePath(), nameservers);
    } else {
      if (this.networkConfig.useNameserversFromWAN) {
        const routingPlugin = pl.getPluginInstance("routing", this.name) || pl.getPluginInstance("routing", "global");
        if (routingPlugin) {
          this.subscribeChangeFrom(routingPlugin);
          await this._linkWANResolvConf(routingPlugin);
        } else {
          this.fatal(`Cannot find routing plugin for ${this.name}`);
        }
      }
    }
  }

  async applyDefaultResolvConf() {
    await fs.unlinkAsync(this._getResolvFilePath()).catch((err) => {});
    if (this.networkConfig.nameservers || this.networkConfig.dns6Servers) {
      let dnsservers = this.networkConfig.nameservers || [];
      dnsservers = dnsservers.filter(i => new Address4(i).isValid());
      if (this.networkConfig.dns6Servers && _.isArray(this.networkConfig.dns6Servers))
        dnsservers = dnsservers.concat(this.networkConfig.dns6Servers.filter(i => new Address6(i).isValid()));
      if (dnsservers.length == 0) {
        this.fatal("Cannot find valid dns options for", this.name);
        return;
      }
      this.log.info("write dns conf file", this.name, dnsservers);
      const nameservers = _.uniq(dnsservers).map((n) => `nameserver ${n}`).join("\n") + "\n";
      await fs.writeFileAsync(this._getResolvFilePath(), nameservers);
    } else {
      if (this.networkConfig.useNameserversFromWAN) {
        const routingPlugin = pl.getPluginInstance("routing", "global");
        if (routingPlugin) {
          this.subscribeChangeFrom(routingPlugin);
          await this._linkWANResolvConf(routingPlugin);
        } else {
          this.fatal(`Cannot find routing plugin for ${this.name}`);
        }
      }
    }
    await execFile("sudo", ["rm", "-f", "/etc/resolv.conf"]);
    await execFile("sudo", ["ln", "-s", this._getResolvFilePath(), "/etc/resolv.conf"]);
  }

  _restartService() {
    if (!_restartTask) {
      _restartTask = setTimeout(() => {
        exec("sudo systemctl stop firerouter_dns; sudo systemctl start firerouter_dns").catch((err) => {
          this.log.warn("Failed to restart firerouter_dns", err.message);
        });
        _restartTask = null;
      }, 5000);
    }
  }

  async apply() {
    const confPath = this._getConfFilePath();
    await fs.unlinkAsync(confPath).catch((err) => {});
    await fs.unlinkAsync(this._getResolvFilePath()).catch((err) => {});
    if (this.name !== "default") {
      const intfPlugin = pl.getPluginInstance("interface", this.name);
      if (!intfPlugin) {
        this.log.error(`Cannot find interface plugin for ${this.name}`);
        return;
      }
      this._intfUuid = intfPlugin.networkConfig && intfPlugin.networkConfig.meta && intfPlugin.networkConfig.meta.uuid;
      if (!this._intfUuid)
        this.fatal(`Cannot find interface uuid for ${this.name}`);
      this.subscribeChangeFrom(intfPlugin);
      if (await intfPlugin.isInterfacePresent() === false) {
        this.log.warn(`Interface ${this.name} is not present yet`);
        return;
      }
      if (!intfPlugin.networkConfig.enabled) {
        this.log.warn(`Interface ${this.name} is not enabled`);
        return;
      }
      const state = await intfPlugin.state();
      if (!state || (!state.ip4 && !state.ip6)) {
        this.log.warn(`Interface ${this.name} does not have IPv4 or IPv6 address`);
        return;
      }
      await this.prepareEnvironment();
      await this.writeDNSConfFile();
      this._restartService();
    } else {
      await this.applyDefaultResolvConf();
    }
  }

  onEvent(e) {
    if (!event.isLoggingSuppressed(e))
      this.log.info(`Received event on ${this.name}`, e);
    const eventType = event.getEventType(e);
    switch (eventType) {
      case event.EVENT_WAN_SWITCHED:
      case event.EVENT_DNS6_CHANGE:
      case event.EVENT_IP_CHANGE: {
        this._reapplyNeeded = true;
        pl.scheduleReapply();
        break;
      }
      default:
    }
  }
}

module.exports = DNSPlugin;
