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

  it('should not replace or mutate the live plugin registry during dry-run', async () => {
    platform.prepareWLANRegDomainChange = async function() {
      return false;
    };

    /*
     * initPlugins() creates the live category maps and loads the configured
     * plugin constructors. Its system-level preparation calls are not part
     * of this regression and are therefore not used here after initialization.
     */
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

    await pluginLoader.reapply(candidateConfig, true);

    expect(pluginLoader.getPluginInstances('interface')).to.equal(originalRegistry);
    expect(pluginLoader.getPluginInstance('interface', 'eth0')).to.equal(originalLivePlugin);
    expect(originalLivePlugin.networkConfig).to.deep.equal(originalLiveConfig);
  });
});
