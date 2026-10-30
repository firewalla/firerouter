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

const InterfaceBasePlugin = require('./intf_base_plugin.js');

const { exec, execFile } = require('child-process-promise');
const r = require('../../util/firerouter.js');
const util = require('../../util/util.js');
const fs = require('fs');
const Promise = require('bluebird');
const pl = require('../plugin_loader.js');
Promise.promisifyAll(fs);
const event = require('../../core/event.js');

const pppoeTemplateFilePath = `${r.getFireRouterHome()}/etc/ppp.conf.template`

class PPPoEInterfacePlugin extends InterfaceBasePlugin {

  static async preparePlugin() {
    // copy pppd hook script
    await exec(`sudo rm /etc/ppp/ip-up.d/firerouter_*`).catch((err) => {});
    await execFile("sudo", ["cp", `${r.getFireRouterHome()}/scripts/firerouter_ppp_ip_up`, "/etc/ppp/ip-up.d/"]).catch((err) => {});
    await execFile("sudo", ["cp", `${r.getFireRouterHome()}/scripts/firerouter_ppp_ipv6_up`, "/etc/ppp/ipv6-up.d/"]).catch((err) => {});
    await execFile("mkdir", ["-p", `${r.getUserConfigFolder()}/pppoe`]).catch((err) => {});
    // copy firerouter_pppd.service
    await execFile("sudo", ["cp", `${r.getFireRouterHome()}/scripts/firerouter_pppd@.service`, "/etc/systemd/system/"]);
  }

  async flushIP(af = null) {
    if (!af) {
      await execFile("sudo", ["systemctl", "stop", `firerouter_pppd@${this.name}`]).catch((err) => {});
      await execFile("rm", ["-f", this._getConfFilePath()]).catch((err) => {});
      // make sure to stop dhcpv6 client no matter if dhcp6 is enabled
      await execFile("sudo", ["systemctl", "stop", `firerouter_dhcpcd6@${this.name}`]).catch((err) => {});
      // remove dhcpcd lease file to ensure it will trigger PD_CHANGE event when it is re-applied
      const lease6Filename = await this._getDHCPCDLease6Filename();
      if (lease6Filename)
        await execFile("sudo", ["rm", "-f", lease6Filename]).catch((err) => {});
    } else
      await super.flushIP(af);
  }

  isWAN() {
    return true;
  }

  isLAN() {
    return false;
  }

  _getConfFilePath() {
    return `${r.getUserConfigFolder()}/pppoe/${this.name}.conf`;
  }

  _getResolvConfFilePath() {
    return `/etc/ppp/${this.name}.resolv.conf`
  }

  async getLinkAddress() {
    const addr = await execFile("cat", [`/sys/class/net/${this.networkConfig.intf}/address`]).then((result) => result.stdout.trim() || null).catch((err) => {
      this.log.error(`Failed to get hardware address of ${this.networkConfig.intf}`, err.message);
    });
    return addr;
  }

  // Encodes a config value as one pppd word for etc/ppp.conf.template, where it is written inside
  // single quotes. pppd parses that file word by word and scripts/firerouter_pppd@.service gives it
  // no User= of its own, so a value that escapes its quoting becomes a further pppd option read as
  // root.
  //
  // pppd's getword() applies the backslash inside quotes exactly as outside: the escape test is not
  // gated on the quote state, so `\\` yields one backslash, `\'` yields a quote that does not close
  // the word, and `\n` `\t` `\b` `\ddd` `\xNN` yield the bytes they name. Escaping the backslash and
  // the quote is the exact inverse of that reader, and is what makes the value arrive as typed: a
  // value ending in a backslash would otherwise consume the closing quote and swallow the rest of
  // the file, and one containing `\b` or `\xNN` would arrive as that byte instead.
  //
  // A control character would in fact survive this encoding - inside a quote pppd stores a raw
  // newline or tab like any other byte - so refusing one is the config policy the rest of the tree
  // applies (util.REGEX_CONTROL_CHARS, the same class validateConfig sweeps with), not a limit of
  // the encoding. It also keeps the unquoted slots in the same template honest.
  _quotedPPPDWord(value, name) {
    const word = String(value);
    if (util.REGEX_CONTROL_CHARS.test(word)) {
      this.log.error(`${name} of pppoe ${this.name} contains a control character`);
      return null;
    }
    return word.replace(/([\\'])/g, "\\$1");
  }

  async createInterface() {
    // create config file instead
    if (!this.networkConfig || !this.networkConfig.username || !this.networkConfig.password) {
      this.log.error("username or password is not specified for pppoe", this.name);
      return false;
    }
    let config = await fs.readFileAsync(pppoeTemplateFilePath, {encoding: "utf8"});
    const username = this._quotedPPPDWord(this.networkConfig.username, "username");
    const password = this._quotedPPPDWord(this.networkConfig.password, "password");
    // throw rather than return false: apply() only warns on a false return, so a rejection there
    // reads as a successful apply to the loader while flush() has already taken the link down
    if (username === null || password === null)
      this.fatal(`username or password of pppoe ${this.name} cannot be written to the options file`);
    const intf = this.networkConfig.intf;
    // the bound is only there to keep a non-integer out of the options file, so it has to admit
    // everything a client can already have saved: the app accepts an mru of 68 to 65535 and an mtu
    // of 1280 to 9000 (NSNumber+VlanValidation.m), and pppd's rp-pppoe plugin clamps an mru above
    // the link limit rather than refusing it. A tighter ceiling here would silently rewrite a
    // working persisted value instead of honouring it
    const mru = util.toBoundedInt(this.networkConfig.mru, 68, 65535) || 1492;
    const mtu = util.toBoundedInt(this.networkConfig.mtu, 128, 16384) || 1492;
    const linkname = this.name;
    const placeholderValues = {
      USERNAME: username,
      PASSWORD: password,
      INTF: intf,
      MRU: mru,
      MTU: mtu,
      LINKNAME: linkname
    };
    // a function replacement, so each value is inserted literally: a string replacement would read
    // $& $` $' in it as substitution patterns and splice parts of this template back in, newlines
    // and all, putting a line break into the options file that _quotedPPPDWord never sees. One pass
    // over all the placeholders also keeps a value that itself reads like a placeholder from being
    // substituted again by a later round
    config = config.replace(/#(USERNAME|PASSWORD|INTF|MRU|MTU|LINKNAME)#/g, (match, key) => String(placeholderValues[key]));
    if (this.networkConfig.dhcp6 || (this.networkConfig.ipv6 && this.networkConfig.ipv6.length > 0))
      config = `${config}\n+ipv6`;
    if (this.networkConfig.serviceName) {
      const serviceName = this._quotedPPPDWord(this.networkConfig.serviceName, "serviceName");
      if (serviceName === null)
        this.fatal(`serviceName of pppoe ${this.name} cannot be written to the options file`);
      config = `${config}\nrp_pppoe_service '${serviceName}'`;
    }
    const intfPlugin = pl.getPluginInstance("interface", intf);
    if (intfPlugin) {
      this.subscribeChangeFrom(intfPlugin);
      await fs.writeFileAsync(this._getConfFilePath(), config);
    } else {
      this.fatal(`Failed to find interface plugin ${intf}`);
    }
    return true;
  }

  async interfaceUpDown() {
    if (this.networkConfig.enabled) {
      await execFile("sudo", ["systemctl", "restart", `firerouter_pppd@${this.name}`]).catch((err) => {
        this.log.error(`Failed to enable pppd on interface ${this.name}: ${err.message}`);
      });
    } else {
      await execFile("sudo", ["systemctl", "stop", `firerouter_pppd@${this.name}`]).catch((err) => {});
    }
  }

  async applyIpSettings() {
    // IPv4 address is assigned by pppd and IPv6 will be triggered by event if applicable
  }

  async applyDnsSettings() {
    await fs.lstatAsync(r.getInterfaceResolvConfPath(this.name)).then(() => {
      this.log.info(`Remove old resolv conf for ${this.name}`);
      return fs.unlinkAsync(r.getInterfaceResolvConfPath(this.name));
    }).catch((err) => { });
    // specified DNS nameservers supersedes those assigned by DHCP
    if (this.networkConfig.nameservers && this.networkConfig.nameservers.length > 0) {
      const nameservers = this.networkConfig.nameservers.map((nameserver) => `nameserver ${nameserver}`).join("\n");
      await fs.writeFileAsync(r.getInterfaceResolvConfPath(this.name), nameservers);
    } else {
      await fs.symlinkAsync(this._getResolvConfFilePath(), r.getInterfaceResolvConfPath(this.name));
    }
  }

  async carrierState() {
    // carrier of pppoe interface in /sys/class/net is not up-to-date, need to get carrier of base interface
    const state = await super.carrierState();
    let baseIntfState = state;
    if (state === "1") {
      if (this.networkConfig.intf) {
        const baseIntfPlugin = pl.getPluginInstance("interface", this.networkConfig.intf);
        if (baseIntfPlugin)
          baseIntfState = await baseIntfPlugin.carrierState();
      }
    }
    return baseIntfState;
  }

  hasHardwareAddress() {
    return false;
  }

  onEvent(e) {
    super.onEvent(e);
    const eventType = event.getEventType(e);
    if (eventType === event.EVENT_PPPOE_IPV6_UP) {
      this.applyIpv6Settings().catch((err) => {
        this.log.error(`Failed to apply IPv6 settings on ${this.name}`, err.message);
      });
    }
    if (eventType === event.EVENT_IP_CHANGE) {
      this.setSysOpts().catch((err) => {
        this.log.error(`Failed to set sys opts on ${this.name}`, err.message);
      });
    }
  }

  isEthernetBasedInterface() {
    return true;
  }
}

module.exports = PPPoEInterfacePlugin;
