'use strict';

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');
const exec = require('child-process-promise').exec;
const util = require('../../util/util');
const pl = require('../plugin_loader.js');

class NatPlugin extends Plugin {

  async flush() {
    if (!this.networkConfig) {
      log.error(`Network config of ${this.name} is not given.`);
      return;
    }

    const iif = this.networkConfig.in;
    const oif = this.networkConfig.out;

    if (!iif || !oif) {
      log.error(`Invalid config of ${this.name}`, this.networkConfig);
      return;
    }

    const iifPlugin = pl.getPluginInstance("interface", iif);
    if (iifPlugin) {
      const state = await iifPlugin.state();
      if (state && state.ip4) {
        await exec(util.wrapIptables(`sudo iptables -t nat -D POSTROUTING -s ${state.ip4} -o ${oif} -j MASQUERADE`));
      } else {
        log.error("Failed to get ip4 of incoming interface " + iif);
      }
    }
  }

  async apply() {
    if (!this.networkConfig) {
      log.error(`Network config of ${this.name} is not given.`);
      return;
    }

    const iif = this.networkConfig.in;
    const oif = this.networkConfig.out;

    if (!iif || !oif) {
      log.error(`Invalid config of ${this.name}`, this.networkConfig);
      return;
    }

    const iifPlugin = pl.getPluginInstance("interface", iif);
    if (iifPlugin) {
      const state = await iifPlugin.state();
      if (state && state.ip4) {
        await exec(util.wrapIptables(`sudo iptables -t nat -A POSTROUTING -s ${state.ip4} -o ${oif} -j MASQUERADE`));
      } else {
        log.error("Failed to get ip4 of incoming interface " + iif);
      }
    }
  }
}

module.exports = NatPlugin;