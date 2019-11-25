'use strict';

class NetworkConfig {
  constructor(json) {
    this.json = json;
  }

  isValid() {
    return true;
  }
}

module.exports = NetworkConfig;