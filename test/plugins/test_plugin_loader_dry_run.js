/*    Copyright 2019-2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const path = require('path');
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

const chai = require('chai');
const expect = chai.expect;

const Plugin = require('../../plugins/plugin.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();
const pluginLoader = require('../../plugins/plugin_loader.js');

describe('Test plugin loader dry-run', function() {
  this.timeout(30000);

  let originalPrepareWLANRegDomainChange;

  beforeEach(() => {
    originalPrepareWLANRegDomainChange = platform.prepareWLANRegDomainChange;
  });

  afterEach(() => {
    platform.prepareWLANRegDomainChange = originalPrepareWLANRegDomainChange;
  });

  it('should not prepare WLAN regulatory domain during dry-run', async () => {
    let prepareCalls = 0;

    platform.prepareWLANRegDomainChange = async function() {
      prepareCalls += 1;
      return true;
    };

    const config = {
      interface: {}
    };

    await pluginLoader.reapply(config, true);

    expect(prepareCalls).to.equal(0);
  });

  it('should not touch the live registry for a config-less dry-run', async () => {
    await pluginLoader.initPlugins();

    const originalRegistry = pluginLoader.getPluginInstances('interface');
    const originalLastAppliedTimestamp = pluginLoader.getLastAppliedTimestamp();

    const errors = await pluginLoader.reapply(null, true);

    expect(errors).to.deep.equal([]);
    expect(pluginLoader.getPluginInstances('interface')).to.equal(originalRegistry);
    expect(pluginLoader.getLastAppliedTimestamp()).to.equal(originalLastAppliedTimestamp);
  });

  it('should resolve plugin lookups against the dry-run candidate registry', async () => {
    platform.prepareWLANRegDomainChange = async function() {
      return false;
    };

    /*
     * initPlugins() creates the live category maps and loads the configured
     * plugin constructors. Its system-level preparation calls are not part
     * of this regression and are therefore not used here after initialization.
     */
    await pluginLoader.initPlugins();

    const liveInterfacePlugins = pluginLoader.getPluginInstances('interface');
    expect(liveInterfacePlugins).to.be.an('object');

    const PhyInterfacePlugin = require('../../plugins/interface/phy_intf_plugin.js');
    const livePlugin = new PhyInterfacePlugin('eth0');

    livePlugin.name = 'eth0';
    livePlugin.networkConfig = {
      enabled: true,
      marker: 'live'
    };

    liveInterfacePlugins.eth0 = livePlugin;

    const originalRegistry = pluginLoader.getPluginInstances('interface');
    const originalLivePlugin = pluginLoader.getPluginInstance('interface', 'eth0');
    const originalLiveConfig = JSON.parse(
      JSON.stringify(originalLivePlugin.networkConfig)
    );

    const observedPluginInstances = [];
    const observedPlugin = [];
    const originalConfigure = PhyInterfacePlugin.prototype.configure;
    let releaseConfigure;
    let configureStartedResolve;
    let firstConfigure = true;
    const configureStarted = new Promise((resolve) => {
      configureStartedResolve = resolve;
    });
    const configureRelease = new Promise((resolve) => {
      releaseConfigure = resolve;
    });

    PhyInterfacePlugin.prototype.configure = async function(networkConfig) {
      observedPluginInstances.push(pluginLoader.getPluginInstances('interface'));
      observedPlugin.push(pluginLoader.getPluginInstance('interface', this.name));
      if (firstConfigure) {
        firstConfigure = false;
        configureStartedResolve();
        await configureRelease;
      }
      return originalConfigure.call(this, networkConfig);
    };

    const candidateConfig = {
      interface: {
        phy: {
          eth0: {
            enabled: false,
            marker: 'candidate'
          }
        }
      }
    };
    const originalCandidateConfig = JSON.parse(JSON.stringify(candidateConfig));
    const originalLastAppliedTimestamp = pluginLoader.getLastAppliedTimestamp();

    try {
      const dryRun = pluginLoader.reapply(candidateConfig, true);
      await configureStarted;

      // The dry-run is suspended inside configure(). An unrelated caller must
      // continue to see the live registry rather than the candidate registry.
      expect(pluginLoader.getPluginInstances('interface')).to.equal(originalRegistry);
      expect(pluginLoader.getPluginInstance('interface', 'eth0')).to.equal(originalLivePlugin);

      releaseConfigure();
      await dryRun;
    } finally {
      releaseConfigure();
      PhyInterfacePlugin.prototype.configure = originalConfigure;
    }

    expect(observedPluginInstances).to.have.length.greaterThan(0);
    expect(observedPlugin).to.have.length.greaterThan(0);
    expect(observedPluginInstances.every(registry => registry !== originalRegistry)).to.equal(true);
    expect(observedPlugin.every(instance => instance !== originalLivePlugin)).to.equal(true);
    expect(observedPlugin.every(instance => instance && instance !== livePlugin)).to.equal(true);
    expect(observedPlugin.every(instance => instance === observedPluginInstances[0].eth0)).to.equal(true);
    expect(candidateConfig).to.deep.equal(originalCandidateConfig);
    expect(pluginLoader.getLastAppliedTimestamp()).to.equal(originalLastAppliedTimestamp);
    expect(pluginLoader.getPluginInstances('interface')).to.equal(originalRegistry);
    expect(pluginLoader.getPluginInstance('interface', 'eth0')).to.equal(originalLivePlugin);
    expect(originalLivePlugin.networkConfig).to.deep.equal(originalLiveConfig);
  });

  it('should configure a newly created plugin exactly once during dry-run', async () => {
    platform.prepareWLANRegDomainChange = async function() {
      return false;
    };

    await pluginLoader.initPlugins();

    const PhyInterfacePlugin = require('../../plugins/interface/phy_intf_plugin.js');
    const newInstanceName = 'dryrun-new0';
    const originalConfigure = PhyInterfacePlugin.prototype.configure;
    let configureCalls = 0;

    PhyInterfacePlugin.prototype.configure = async function(networkConfig) {
      configureCalls += 1;
      return originalConfigure.call(this, networkConfig);
    };

    const candidateConfig = {
      interface: {
        phy: {
          [newInstanceName]: {
            enabled: false,
            marker: 'candidate'
          }
        }
      }
    };

    try {
      await pluginLoader.reapply(candidateConfig, true);
    } finally {
      PhyInterfacePlugin.prototype.configure = originalConfigure;
    }

    expect(configureCalls).to.equal(1);
    expect(pluginLoader.getPluginInstance('interface', newInstanceName)).to.equal(undefined);
  });

  it('should not replace or mutate the live plugin registry during dry-run', async () => {
    platform.prepareWLANRegDomainChange = async function() {
      return false;
    };

    await pluginLoader.initPlugins();

    const interfacePlugins = pluginLoader.getPluginInstances('interface');
    expect(interfacePlugins).to.be.an('object');

    const PhyInterfacePlugin = require('../../plugins/interface/phy_intf_plugin.js');
    const livePlugin = new PhyInterfacePlugin('eth0');

    livePlugin.name = 'eth0';
    livePlugin.networkConfig = {
      enabled: true,
      marker: 'live'
    };

    interfacePlugins.eth0 = livePlugin;

    const originalRegistry = pluginLoader.getPluginInstances('interface');
    const originalLivePlugin = pluginLoader.getPluginInstance('interface', 'eth0');
    const originalLiveConfig = JSON.parse(
      JSON.stringify(originalLivePlugin.networkConfig)
    );

    const candidateConfig = {
      interface: {
        phy: {
          eth0: {
            enabled: false,
            marker: 'candidate'
          }
        }
      }
    };
    const originalCandidateConfig = JSON.parse(JSON.stringify(candidateConfig));
    const originalLastAppliedTimestamp = pluginLoader.getLastAppliedTimestamp();

    await pluginLoader.reapply(candidateConfig, true);

    expect(candidateConfig).to.deep.equal(originalCandidateConfig);
    expect(pluginLoader.getLastAppliedTimestamp()).to.equal(originalLastAppliedTimestamp);
    expect(pluginLoader.getPluginInstances('interface')).to.equal(originalRegistry);
    expect(pluginLoader.getPluginInstance('interface', 'eth0')).to.equal(originalLivePlugin);
    expect(originalLivePlugin.networkConfig).to.deep.equal(originalLiveConfig);
  });

  it('should restore live state after a dry-run throws', async () => {
    platform.prepareWLANRegDomainChange = async function() {
      return false;
    };

    await pluginLoader.initPlugins();

    const originalRegistry = pluginLoader.getPluginInstances('interface');
    expect(originalRegistry).to.be.an('object');

    const PhyInterfacePlugin = require('../../plugins/interface/phy_intf_plugin.js');
    const livePlugin = new PhyInterfacePlugin('eth0');

    livePlugin.name = 'eth0';
    livePlugin.networkConfig = {
      enabled: true,
      marker: 'live'
    };

    originalRegistry.eth0 = livePlugin;

    const originalLivePlugin = pluginLoader.getPluginInstance('interface', 'eth0');
    const originalLiveConfig = JSON.parse(
      JSON.stringify(originalLivePlugin.networkConfig)
    );
    const candidateConfig = {
      interface: {
        phy: {
          eth0: {
            enabled: false,
            marker: 'candidate'
          }
        }
      }
    };
    const originalCandidateConfig = JSON.parse(JSON.stringify(candidateConfig));
    const originalLastAppliedTimestamp = pluginLoader.getLastAppliedTimestamp();

    const originalPropagateConfigChanged = Plugin.prototype.propagateConfigChanged;
    const expectedError = new Error('dry-run regression test');

    Plugin.prototype.propagateConfigChanged = function() {
      throw expectedError;
    };

    try {
      const errors = await pluginLoader.reapply(candidateConfig, true);

      expect(errors).to.deep.equal([expectedError.message]);
    } finally {
      Plugin.prototype.propagateConfigChanged = originalPropagateConfigChanged;
    }

    /*
     * The exception occurs while operating on the temporary dry-run registry.
     * The finally block in reapply() must restore the original live registry
     * and leave the existing live plugin untouched.
     */
    expect(pluginLoader.getPluginInstances('interface')).to.equal(originalRegistry);
    expect(pluginLoader.getPluginInstance('interface', 'eth0')).to.equal(originalLivePlugin);
    expect(originalLivePlugin.networkConfig).to.deep.equal(originalLiveConfig);
  });
});
