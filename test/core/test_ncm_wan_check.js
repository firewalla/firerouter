/*    Copyright 2026 Firewalla Inc.
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

'use strict'

const path = require('path');
// plugin_loader reads config/config.json from here, so this also runs off-device
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

const expect = require('chai').expect;
const pl = require('../../plugins/plugin_loader.js');
const ncm = require('../../core/network_config_mgr.js');

describe('Test manual WAN connectivity check', function() {
  const origGetPluginInstance = pl.getPluginInstance;
  let propagated;
  let local;
  let active;

  beforeEach(() => {
    propagated = [];
    local = [];
    active = true;
    const intfPlugin = {
      isWAN: () => true,
      checkWanConnectivity: async () => ({active, carrier: false}),
      onEvent: (e) => local.push(e),
      propagateEvent: (e) => propagated.push(e),
    };
    pl.getPluginInstance = (category, name) => category === "interface" && name === "wlan0" ? intfPlugin : null;
  });
  afterEach(() => {
    pl.getPluginInstance = origGetPluginInstance;
  });

  it('should propagate a passed check to the subscribers of the WAN, the routing plugin among them', async () => {
    await ncm.checkWanConnectivity("wlan0", {});
    expect(local).to.eql([]);
    expect(propagated.length).to.equal(1);
    expect(propagated[0].type).to.equal("wan_conn_check");
    expect(propagated[0].payload).to.include({intf: "wlan0", active: true, forceState: true});
  });

  it('should not send any event for a failed check', async () => {
    active = false;
    await ncm.checkWanConnectivity("wlan0", {});
    expect(local).to.eql([]);
    expect(propagated).to.eql([]);
  });
});
