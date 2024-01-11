/*    Copyright 2021 Firewalla Inc
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
const pl = require('../plugin_loader.js');
const r = require('../../util/firerouter.js');
const event = require('../../core/event.js');
const util = require('../../util/util.js');
const fs = require('fs');
const ip = require('ip');
const fsp = fs.promises;
const YAML = require('yaml');
const _ = require('lodash');

class DockerPlugin extends Plugin {
  static async preparePlugin() {
    await exec(`mkdir -p ${r.getUserConfigFolder()}/docker`);
    await exec(`mkdir -p ${r.getUserConfigFolder()}/docker_compose`)
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/firerouter_docker_compose@.service /etc/systemd/system/`);
  }

  _getConvertedComposeFilePath() {
    return `${r.getUserConfigFolder()}/docker_compose/${this.name}/docker-compose.yaml`;
  }

  _getOriginalComposeFilePath() {
    return `${r.getUserConfigFolder()}/docker/${this.name}/docker-compose.yaml`;
  }

  async flush() {
    await exec(`sudo systemctl stop firerouter_docker_compose@${this.name}`).catch((err) => {});
  }

  async _fetchConfigAndFiles() {
    // a unified way to fetch compose.yaml as well as files/directories that will be mapped as volumes in containers
    // we will use self-managed docker images so it is reasonable to provide a general way to prepare all these config files
  }

  async _testAndStartDocker() {
    const active = await exec(`sudo systemctl -q is-active docker`).then(() => true).catch((err) => false);
    if (!active)
      await exec(`sudo systemctl start docker`).catch((err) => {});
  }

  async apply() {
    await this._testAndStartDocker();
    await this._fetchConfigAndFiles();
    const composeConfig = await fsp.readFile(this._getOriginalComposeFilePath(), {encoding: 'utf8'}).then(content => YAML.parse(content)).catch((err) => {
      this.log.error(`Failed to prase original docker compose file for ${this.name}, ${this._getOriginalComposeFilePath()}`, err.message);
      return null;
    });
    if (!composeConfig)
      return;
    // generate compose.yaml
    const services = this.networkConfig.services || {};
    composeConfig.networks = {} // top-level networks config will be populated from firerouter config
    for (const service of Object.keys(services)) {
      const serviceConf = services[service];
      if (!composeConfig.services[service]) {
        this.log.warn(`Service ${service} is not defined in ${this._getOriginalComposeFilePath()} in docker plugin ${this.name}`);
        continue;
      }
      const networks = serviceConf.networks || {}; // service-level networks config is overriden by firerouter config
      composeConfig.services[service].networks = {}
      for (const network of Object.keys(networks)) {
        if (!composeConfig.networks[network]) {
          const dockerNetworkPlugin = pl.getPluginInstance("interface", network);
          if (!dockerNetworkPlugin)
            this.fatal(`Network plugin ${network} is not found in docker plugin ${this.name}`);
          else
            this.subscribeChangeFrom(dockerNetworkPlugin);
          composeConfig.networks[network] = {external: true}; // set external to true since it is created by docker_intf_plugin, not by docker-compose
        }
        const networkConf = networks[network];
        composeConfig.services[service].networks[network] = networkConf;
      }
      const ports = serviceConf.ports;
      if (!_.isEmpty(ports)) {
        // service-level ports config can be overriden by firerouter config
        composeConfig.services[service].ports = [];
        for (const port of ports) {
          const hostIP = port.hostIP;
          const hostPort = port.hostPort;
          const containerPort = port.containerPort;
          const protocol = port.protocol;
          composeConfig.services[service].ports.push(`${hostIP ? `${hostIP}:` : ""}${hostPort}:${containerPort}${protocol ? `/${protocol}` : ""}`);
        }
      }
    }
    await exec(`mkdir -p ${r.getUserConfigFolder()}/docker_compose/${this.name}`);
    await fsp.writeFile(this._getConvertedComposeFilePath(), YAML.stringify(composeConfig), {encoding: 'utf8'}).catch((err) => {
      this.log.error(`Failed to write converted docker compose file for ${this.name}, ${this._getConvertedComposeFilePath()}`, err.message);
    });
    if (this.networkConfig.enabled)
      await exec(`sudo systemctl start firerouter_docker_compose@${this.name}`).catch((err) => {
        this.log.error(`Failed to start firerouter_docker_compose@${this.name}`, err.message);
      });
    else
      await exec(`sudo systemctl stop firerouter_docker_compose@${this.name}`).catch((err) => {});
  }
}

module.exports = DockerPlugin;