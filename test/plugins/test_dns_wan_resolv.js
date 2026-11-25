/*    Copyright 2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
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

// Off-box: which WAN's resolv.conf a dns instance links as its upstream

let chai = require('chai');
let expect = chai.expect;

const stub = require('./stub_exec.js');
const fs = require('fs');
const r = require('../../util/firerouter');
const DNSPlugin = stub.load(require.resolve('../../plugins/dns/dns_plugin.js'));

describe('Test dns upstream from the WAN resolv.conf', function() {
  const orig = {existsSync: fs.existsSync, symlinkAsync: fs.symlinkAsync};
  let resolvFiles;
  let links;
  let plugin;

  // nameservers: null for a WAN without a resolv.conf, [] for an empty one
  const wan = (name, nameservers, present = true) => {
    if (nameservers)
      resolvFiles.add(r.getInterfaceResolvConfPath(name));
    return {name, isInterfacePresent: async () => present, getDNSNameservers: async () => nameservers || []};
  };
  const routing = (all, active, inUse) => ({
    getActiveWANPlugins: () => active,
    getInUseWANPlugins: () => inUse,
    getAllWANPlugins: () => all,
    getPrimaryWANPlugin: () => all[0] || null,
  });
  const linked = () => links.map(l => l.split("/").pop());

  beforeEach(() => {
    resolvFiles = new Set();
    links = [];
    fs.existsSync = (p) => resolvFiles.has(p);
    fs.symlinkAsync = async (target, p) => { links.push(target); };
    plugin = new DNSPlugin("br0");
  });
  afterEach(() => {
    Object.assign(fs, orig);
  });

  it('links the first active WAN', async() => {
    const eth0 = wan("eth0", ["10.0.0.1"]);
    const wlan0 = wan("wlan0", ["10.0.1.1"]);
    await plugin._linkWANResolvConf(routing([eth0, wlan0], [wlan0], [wlan0]));
    expect(linked()).to.eql(["wlan0.resolv.conf"]);
  });

  it('links an in-use WAN with nameservers while no WAN is active', async() => {
    const eth0 = wan("eth0", []);
    const eth1 = wan("eth1", ["10.0.1.1"]);
    await plugin._linkWANResolvConf(routing([eth0, eth1], [], [eth0, eth1]));
    expect(linked()).to.eql(["eth1.resolv.conf"]);
  });

  it('links any WAN with nameservers, else the primary, while no WAN is active or in use', async() => {
    const eth0 = wan("eth0", null);
    const wlan0 = wan("wlan0", ["10.0.1.1"]);
    await plugin._linkWANResolvConf(routing([eth0, wlan0], [], []));
    expect(linked()).to.eql(["wlan0.resolv.conf"]);
    links = [];
    resolvFiles.clear();
    await plugin._linkWANResolvConf(routing([eth0, wlan0], [], []));
    expect(linked()).to.eql(["eth0.resolv.conf"]);
  });

  it('skips a WAN that is not present', async() => {
    const eth0 = wan("eth0", ["10.0.0.1"], false);
    const wlan0 = wan("wlan0", ["10.0.1.1"]);
    await plugin._linkWANResolvConf(routing([eth0, wlan0], [], [eth0, wlan0]));
    expect(linked()).to.eql(["wlan0.resolv.conf"]);
  });

  it('links nothing when no in-use WAN has nameservers', async() => {
    // e.g. a Wi-Fi WAN between uplinks: the unplugged eth1 is in use, wlan0 already has the new uplink's nameservers
    const eth1 = wan("eth1", []);
    const wlan0 = wan("wlan0", ["10.0.1.1"]);
    await plugin._linkWANResolvConf(routing([eth1, wlan0], [], [eth1]));
    expect(linked()).to.eql([]);
  });
});
