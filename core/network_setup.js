'use strict'

let instance = null;
const pl = require('../plugins/plugin_loader.js');
const routing = require('../util/routing.js');
const log = require('../util/logger.js')(__filename);
const r = require('../util/firerouter.js');

const exec = require('child-process-promise').exec;

class NetworkSetup {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async prepareEnvironment() {
    // create dhclient runtime folder
    await exec(`mkdir -p ${r.getRuntimeFolder()}/dhclient`);
    // copy dhclient-script
    await exec(`sudo cp ${r.getFireRouterHome()}/scripts/dhclient-script /sbin/dhclient-script`);
    // reset ip rules
    await routing.flushPolicyRoutingRules();
    await routing.createPolicyRoutingRule("all", null, "local", 0); 
    await routing.createPolicyRoutingRule("all", null, "main", 32766);
    await routing.createPolicyRoutingRule("all", null, "default", 32767);
    // create routing tables
    await routing.createCustomizedRoutingTable(routing.RT_GLOBAL_LOCAL);
    await routing.createCustomizedRoutingTable(routing.RT_GLOBAL_DEFAULT);
    await routing.createCustomizedRoutingTable(routing.RT_ROUTABLE);
    await routing.createCustomizedRoutingTable(routing.RT_STATIC);
    await routing.flushRoutingTable(routing.RT_GLOBAL_LOCAL);
    await routing.flushRoutingTable(routing.RT_GLOBAL_DEFAULT);
    await routing.flushRoutingTable(routing.RT_ROUTABLE);
    await routing.flushRoutingTable(routing.RT_STATIC);

    await routing.createPolicyRoutingRule("all", null, routing.RT_GLOBAL_LOCAL, 3000);
    await routing.createPolicyRoutingRule("all", null, routing.RT_STATIC, 4001);
  }

  async setup(config) {
    await pl.reapply(config);
  }
}

module.exports = new NetworkSetup();