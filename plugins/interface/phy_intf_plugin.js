'use strict';

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');
const _ = require('lodash');

const exec = require('child-process-promise').exec;

class PhyInterfacePlugin extends Plugin {
  init(config) {
    super.init(config);
  }

  async flush(name) {

  }

  async run(name, networkConfig) {
    log.info(`Setup network ${name} with config`, networkConfig);
    if(_.isEmpty(networkConfig)) {
      log.info("Nothing to configure");
      return;
    }

    if(networkConfig.enabled) {
      await exec(`sudo ip link set ${name} up`);
    }

    if(networkConfig.dhcp) {
      await exec(`sudo dhclient -i ${name}`);
    }

    await exec(`sudo bash -c '/bin/echo "nameserver 1.1.1.1" >> /etc/resolv.conf'`);
  }
}

module.exports = PhyInterfacePlugin;