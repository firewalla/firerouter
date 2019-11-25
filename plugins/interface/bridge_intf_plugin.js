'use strict';

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');
const exec = require('child-process-promise').exec;
const _ = require('lodash');

class BridgeInterfacePlugin extends Plugin {
  init(config) {
    super.init(config);
  }

  async flush(name) {
    log.info("Flushing bridge", name);
    await exec(`sudo ip link set dev ${name} down`);
    await exec(`sudo brctl delbr ${name}`);
  }

  async run(name, networkConfig) {
    log.info(`Setup network ${name} with config`, networkConfig);

    if(_.isEmpty(networkConfig.intf)) {
      log.error("Invalid bridge config");
      return;
    }

    if(!networkConfig.enabled) {
      log.info(`Interface ${name} is disabled`);
      return;
    }

    for(const intf of networkConfig.intf) {
      await exec(`sudo ip addr flush dev ${intf}`);
    }

    await exec(`sudo brctl addbr ${name}`);
    await exec(`sudo brctl addif ${name} ${networkConfig.intf.join(" ")}`);
    await exec(`sudo ip link set dev ${name} up`);

    if(networkConfig.ipv4) {
      await exec(`sudo ip addr add ${networkConfig.ipv4} dev ${name}`).catch((err) => {
        log.error(`Got error when setup ipv4: ${err}`);
      });
    }
  }
}

module.exports = BridgeInterfacePlugin;