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

const Plugin = require('../plugin.js');
const exec = require('child-process-promise').exec;
const pl = require('../plugin_loader.js');
const r = require('../../util/firerouter.js');
const event = require('../../core/event.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
let _reloadTask = null;

class MDNSReflectorPlugin extends Plugin {

  static async preparePlugin() {
    await exec(`mkdir -p ${r.getUserConfigFolder()}/mdns_reflector`);
    await exec(`sudo systemctl disable avahi-daemon`).catch((err) => {});
    // redirect avahi-daemon log to specific log file
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/rsyslog.d/11-avahi-daemon.conf /etc/rsyslog.d/`);
    pl.scheduleRestartRsyslog();
    // copy logrotate config for avahi-daemon log file
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/logrotate.d/avahi-daemon /etc/logrotate.d/`);
  }

  async flush() {
    this.log.info("Flushing MDNSReflector", this.name);
    const confPath = this._getConfFilePath();
    await fs.unlinkAsync(confPath).catch((err) => {});
    await this.reloadMDNSReflector().catch((err) => {});
  }

  async reloadMDNSReflector() {
    if (_reloadTask)
      clearTimeout(_reloadTask);
    _reloadTask = setTimeout(async () => {
      await exec(`${__dirname}/reload_mdns_reflector.sh`).catch((err) => {
        this.log.error(`Failed to reload mdns reflector for ${this.name}`, err.message);
      });
    }, 3000);
  }

  _getConfFilePath() {
    return `${r.getUserConfigFolder()}/mdns_reflector/mdns_reflector.${this.name}`;
  }

  async generateConfFile() {
    const confPath = this._getConfFilePath();
    const iface = this.name;
    const ifacePlugin = pl.getPluginInstance("interface", iface);
    if (ifacePlugin) {
      this.subscribeChangeFrom(ifacePlugin);
      if (!ifacePlugin.networkConfig.enabled) {
        this.log.warn(`Interface ${this.name} is not enabled`);
        return;
      }
      // create a dummy file which indicates mDNS reflector is enabled on this interface
      await fs.writeFileAsync(confPath, iface, {encoding: 'utf8'});
    } else {
      this.log.error("Cannot find interface plugin " + iface);
    }
  }

  async apply() {
    if (this.networkConfig.enabled) {
      await this.generateConfFile();
      await this.reloadMDNSReflector();
    } else {
      const confPath = this._getConfFilePath();
      await fs.unlinkAsync(confPath).catch((err) => {});
      await this.reloadMDNSReflector();
    }
  }

  onEvent(e) {
    if (!event.isLoggingSuppressed(e))
      this.log.info(`Received event on ${this.name}`, e);
    const eventType = event.getEventType(e);
    switch (eventType) {
      case event.EVENT_IP_CHANGE: {
        this._reapplyNeeded = true;
        pl.scheduleReapply();
        break;
      }
      default:
    }
  }
}

module.exports = MDNSReflectorPlugin;