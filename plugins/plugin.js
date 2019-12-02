'use strict';

const log = require('../util/logger.js')(__filename);

class Plugin {
  constructor(name) {
    this.name = name;
    return this;
  }

  init(pluginConfig) {
    this.pluginConfig = pluginConfig;
    log.info(`Initializing Plugin ${this.constructor.name}...`);
  }

  configure(networkConfig) {
    this.networkConfig = networkConfig;
  }

  async flush() {
  }

  async apply() {
  }

  async status() {
    return false;
  }

  async state() {
    return null;
  }
}

module.exports = Plugin;