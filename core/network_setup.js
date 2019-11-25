'use strict'

let instance = null;
const pl = require('../plugins/plugin_loader.js');
const log = require('../util/logger.js')(__filename);

class NetworkSetup {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async phySetup(config) {
    const phyPlugin = pl.getPlugin("phy_intf_plugin");
    if(!phyPlugin) {
      log.error("no phy related plugin.");
      return;
    }

    log.info("Setting up physical interfaces...");
    for(const intfName in config) {
      const intfConfig = config[intfName];
      await phyPlugin.run(intfName, intfConfig);
    }
  }

  async bridgeSetup(config) {
    const bridgePlugin = pl.getPlugin("bridge_intf_plugin");
    if(!bridgePlugin) {
      log.error("no bridge related plugin.");
      return;
    }

    log.info("Setting up bridge interfaces...");
    for(const intfName in config) {
      const intfConfig = config[intfName];
      await bridgePlugin.flush(intfName).catch((err) => {
        log.error("Got error when flush bridge", intfName);
      });
      await bridgePlugin.run(intfName, intfConfig);
    }
  }

  async dnsSetup(config) {
    log.info("Setting up DNS...");

    const dnsPlugin = pl.getPlugin("dns_plugin");
    if(!dnsPlugin) {
      log.error("no dns related plugin.");
      return;
    }

    await dnsPlugin.run("", config);
  }

  async natSetup(config) {
    log.info("Setting up NAT...");

    const natPlugin = pl.getPlugin("nat_plugin");
    if(!natPlugin) {
      log.error("no nat related plugin.");
      return;
    }

    await natPlugin.run("", config);
  }

  async dhcpSetup(config) {
    log.info("Setting up DHCP...");

    const dhcpPlugin = pl.getPlugin("dhcp_plugin");
    if(!dhcpPlugin) {
      log.error("no dhcp related plugin.");
      return;
    }

    await dhcpPlugin.run("", config);
  }

  async setup(config) {
    // phy
    if(config.interface && config.interface.phy) {
      await this.phySetup(config.interface.phy);
    }

    if(config.interface && config.interface.bridge) {
      await this.bridgeSetup(config.interface.bridge);
    }

    // dns
    if(config.dns) {
      await this.dnsSetup(config.dns);
    }
    // nat
    if(config.nat) {
      await this.natSetup(config.nat);
    }
    // dhcp
    if(config.dhcp) {
      await this.dhcpSetup(config.dhcp);
    }
  }
}

module.exports = new NetworkSetup();