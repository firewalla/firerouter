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
  const wan = (name, nameservers, present = true, carrier = "1") => {
    if (nameservers)
      resolvFiles.add(r.getInterfaceResolvConfPath(name));
    return {name, isInterfacePresent: async () => present, getDNSNameservers: async () => nameservers || [],
      carrierState: async () => carrier};
  };
  // backups: names configured as backup.viaIntfs, which are standby unless they are active
  const routing = (all, active, inUse, backups = [], type = "primary_standby") => ({
    networkConfig: {default: {type}},
    getActiveWANPlugins: () => active,
    getInUseWANPlugins: () => inUse,
    getAllWANPlugins: () => all,
    getPrimaryWANPlugin: () => all[0] || null,
    getWANConnState: (name) => ({
      active: active.some(p => p.name === name),
      inUse: inUse.some(p => p.name === name),
      ...(backups.includes(name) ? {backup: true} : {}),
    }),
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

  it('keeps an active WAN that has no carrier, the primary/standby choice is routing\'s', async() => {
    // right after apply_current_config every WAN is optimistically ready, so the wired primary is
    // active before its connectivity check has run
    const eth1 = wan("eth1", ["10.0.0.1"], true, "0");
    const wlan0 = wan("wlan0", ["10.0.1.1"], true, "1");
    await plugin._linkWANResolvConf(routing([eth1, wlan0], [eth1], [eth1]));
    expect(linked()).to.eql(["eth1.resolv.conf"]);
  });

  it('links a WAN with a carrier when the active WAN has no nameservers', async() => {
    const eth1 = wan("eth1", [], true, "0");
    const wlan0 = wan("wlan0", ["10.0.1.1"], true, "1");
    await plugin._linkWANResolvConf(routing([eth1, wlan0], [eth1], [eth1]));
    expect(linked()).to.eql(["wlan0.resolv.conf"]);
  });

  it('still links the active WAN when no WAN has nameservers', async() => {
    const eth1 = wan("eth1", [], true, "0");
    const wlan0 = wan("wlan0", null, true, "1");
    await plugin._linkWANResolvConf(routing([eth1, wlan0], [eth1], [eth1]));
    expect(linked()).to.eql(["eth1.resolv.conf"]);
  });

  it('picks the active WAN with a carrier when load_balance has several, both wired', async() => {
    // load_balance keeps every ready WAN active, so the unplugged eth0 stays first by seq while
    // eth1 is the one carrying traffic
    const eth0 = wan("eth0", ["10.0.0.1"], true, "0");
    const eth1 = wan("eth1", ["10.0.1.1"], true, "1");
    await plugin._linkWANResolvConf(routing([eth0, eth1], [eth0, eth1], [eth0, eth1]));
    expect(linked()).to.eql(["eth1.resolv.conf"]);
  });

  it('does not borrow from a load_balance standby backup, its DNS routes are gone', async() => {
    const eth0 = wan("eth0", [], true, "0");
    const lte0 = wan("lte0", ["10.0.2.1"], true, "1");
    await plugin._linkWANResolvConf(routing([eth0, lte0], [eth0], [eth0], ["lte0"], "load_balance"));
    expect(linked()).to.eql(["eth0.resolv.conf"]);
  });

  it('borrows from a load_balance backup that is itself active', async() => {
    const eth0 = wan("eth0", [], true, "0");
    const lte0 = wan("lte0", ["10.0.2.1"], true, "1");
    await plugin._linkWANResolvConf(routing([eth0, lte0], [eth0, lte0], [lte0], ["lte0"], "load_balance"));
    expect(linked()).to.eql(["lte0.resolv.conf"]);
  });

  it('borrows from a primary_standby backup, which keeps its DNS routes', async() => {
    const eth0 = wan("eth0", [], true, "0");
    const lte0 = wan("lte0", ["10.0.2.1"], true, "1");
    await plugin._linkWANResolvConf(routing([eth0, lte0], [eth0], [eth0], ["lte0"]));
    expect(linked()).to.eql(["lte0.resolv.conf"]);
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

  it('links any WAN with nameservers when no in-use WAN has them', async() => {
    // a Wi-Fi WAN between uplinks: the unplugged eth1 is in use, wlan0 already has the new uplink's nameservers
    const eth1 = wan("eth1", []);
    const wlan0 = wan("wlan0", ["10.0.1.1"]);
    await plugin._linkWANResolvConf(routing([eth1, wlan0], [], [eth1]));
    expect(linked()).to.eql(["wlan0.resolv.conf"]);
  });

  it('prefers a WAN with a carrier over an unplugged one that kept its nameservers', async() => {
    // the same gap, but the unplugged primary still holds the nameservers of its last lease, and it
    // comes first both in the in-use list and by seq in all WANs
    const eth1 = wan("eth1", ["10.99.99.99"], true, "0");
    const wlan0 = wan("wlan0", ["10.0.1.1"], true, "1");
    await plugin._linkWANResolvConf(routing([eth1, wlan0], [], [eth1]));
    expect(linked()).to.eql(["wlan0.resolv.conf"]);
  });

  it('prefers a WAN with a carrier when none is active or in use', async() => {
    const eth1 = wan("eth1", ["10.99.99.99"], true, "0");
    const wlan0 = wan("wlan0", ["10.0.1.1"], true, "1");
    await plugin._linkWANResolvConf(routing([eth1, wlan0], [], []));
    expect(linked()).to.eql(["wlan0.resolv.conf"]);
  });

  it('still links a WAN with no carrier when no WAN has one', async() => {
    const eth1 = wan("eth1", ["10.0.0.1"], true, "0");
    const wlan0 = wan("wlan0", ["10.0.1.1"], true, "0");
    await plugin._linkWANResolvConf(routing([eth1, wlan0], [], [eth1]));
    expect(linked()).to.eql(["eth1.resolv.conf"]);
  });

  it('links a WAN whose carrier cannot be read when no WAN has one, e.g. pppoe', async() => {
    const pppoe0 = wan("pppoe0", ["10.0.0.1"], true, null);
    await plugin._linkWANResolvConf(routing([pppoe0], [], [pppoe0]));
    expect(linked()).to.eql(["pppoe0.resolv.conf"]);
  });

  it('links nothing when no WAN has nameservers', async() => {
    const eth1 = wan("eth1", []);
    const wlan0 = wan("wlan0", null);
    await plugin._linkWANResolvConf(routing([eth1, wlan0], [], [eth1]));
    expect(linked()).to.eql([]);
  });
});
