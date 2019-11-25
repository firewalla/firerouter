'use strict';

let instance = null;
const log = require('../util/logger.js')(__filename);
const rclient = require('../util/redis_manager').getPrimaryDBRedisClient();

class NetworkConfigManager {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async getActiveConfig() {
    const configString = await rclient.getAsync("config");
    if(configString) {
      try {
        const config = JSON.parse(configString);
        return config;
      } catch(err) {
        return null;
      }
    } else {
      return null;
    }
  }
}

module.exports = new NetworkConfigManager();