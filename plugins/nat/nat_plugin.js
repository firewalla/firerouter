'use strict';

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');
const exec = require('child-process-promise').exec;
const util = require('../../util/util');

class NatPlugin extends Plugin {
  init(config) {
    super.init(config);
  }

  async run(name, networkConfig) {
    await exec(util.wrapIptables(`sudo iptables -t nat -A POSTROUTING -s 192.168.218.0/24 -j MASQUERADE`));
  }
}

module.exports = NatPlugin;