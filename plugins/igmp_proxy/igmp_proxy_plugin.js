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

const Plugin = require('../plugin.js');
const exec = require('child-process-promise').exec;
const pl = require('../plugin_loader.js');
const event = require('../../core/event.js');
const r = require('../../util/firerouter.js');
const fs = require('fs');
const ip = require('ip');
const util = require('../../util/util.js');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

class IGMPProxyPlugin extends Plugin {
  static async preparePlugin() {
    await exec(`mkdir -p ${r.getUserConfigFolder()}/igmp_proxy`);
  }

  async flush() {
    await exec("sudo systemctl stop igmpproxy").catch((err) => {});
    await exec(util.wrapIptables(`sudo iptables -w -F FR_IGMP`)).catch((err) => {});
  }

  async generateConfFile() {
    const lines = [];
    const config = this.networkConfig;
    const quickleave = config.hasOwnProperty("quickleave") ? config.quickleave : true;
    if (quickleave)
      lines.push("quickleave");
    
    lines.push("# Configuration for upstream interface");
    lines.push(`phyint ${this.name} upstream ratelimit 0 threshold 1`);
    const altnets = config.altnets || [];
    for (const altnet of altnets)
      lines.push(`\taltnet ${altnet}`);

    lines.push("# Configuration for downstream interfaces");
    const downstream = config.downstream || {};
    for (const intf in downstream) {
      const ifacePlugin = pl.getPluginInstance("interface", intf);
      if (ifacePlugin) {
        this.subscribeChangeFrom(ifacePlugin);
        if (await ifacePlugin.isInterfacePresent() === false) {
          this.log.warn(`Downstream interface ${intf} is not present yet`);
          continue;
        }
        if (downstream[intf] === true && ifacePlugin.networkConfig.enabled === true) {
          lines.push(`phyint ${intf} downstream ratelimit 0 threshold 1`);
        } else {
          lines.push(`phyint ${intf} disabled`);
        }
      } else {
        this.log.error("Cannot find interface plugin " + intf);
      }
    }
    lines.push(''); // add empty line at the end of the file;
    await fs.writeFileAsync(`${r.getUserConfigFolder()}/igmp_proxy/igmpproxy.conf`, lines.join('\n'), {encoding: 'utf8'});
    await exec(`sudo cp ${r.getUserConfigFolder()}/igmp_proxy/igmpproxy.conf /etc/igmpproxy.conf`);
  }

  async updateIptables() {
    const altnets = this.networkConfig.altnets || [];
    await exec(util.wrapIptables(`sudo iptables -w -A FR_IGMP -p 2 -d 224.0.0.0/4 -j ACCEPT`)).catch((err) => {
      this.log.error(`Failed to add IGMP accept rule to FR_IGMP in iptables`, err.message);
    });
    for (const altnet of altnets) {
      await exec(util.wrapIptables(`sudo iptables -w -A FR_IGMP -s ${altnet} -d 224.0.0.0/4 -j ACCEPT`)).catch((err) => {
        this.log.error(`Failed to add altnet ${altnet} to FR_IGMP in iptables`, err.message);
      });
    }
  }

  async apply() {
    if (pl.getPluginInstances("igmp_proxy") && Object.keys(pl.getPluginInstances("igmp_proxy")).some(name => name != this.name))
      this.fatal(`More than 1 igmp proxy instance is not allowed`);

    const intfPlugin = pl.getPluginInstance("interface", this.name);
    if (!intfPlugin)
      this.fatal(`Instance plugin ${this.name} is not found`);
    this.subscribeChangeFrom(intfPlugin);
    if (await intfPlugin.isInterfacePresent() === false) {
      this.log.warn(`Upstream interface ${this.name} is not present yet`);
      return;
    }

    await this.generateConfFile();
    await this.updateIptables();
    await exec(`sudo systemctl stop igmpproxy`).then(() => {
      if (Object.keys(this.networkConfig.downstream).filter(intf => this.networkConfig.downstream[intf]).length > 0)
        return exec(`sudo systemctl start igmpproxy`);
    }).catch((err) => {
      this.log.error("Failed to start igmpproxy", err.message);
    });
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

module.exports = IGMPProxyPlugin;