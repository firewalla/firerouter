'use strict';

const log = require('../util/logger.js')(__filename);

class Plugin {
  init(pluginConfig) {
    this.pluginConfig = pluginConfig;
    log.info(`Initializing Plugin ${this.constructor.name}...`);
  }

  async flush(name) {
  }

  async run(name, networkConfig) {
    log.info(`Configuring network ${name}...`);
  }

  async status() {
    return false;
  }
}

module.exports = Plugin;