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

let chai = require('chai');
let expect = chai.expect;

const fsp = require('fs').promises;
const stub = require('./stub_exec.js');
const sensorLoader = require('../../sensors/sensor_loader.js');
// load the platform classes first, Platform.js on its own would require them while it is still loading
require('../../plugins/plugin_loader.js');
const Platform = stub.load(require.resolve('../../platform/Platform.js'));

// the driver of eth1 and eth2 only takes an MTU change while the link is down, as on GSE
class DownForMTUPlatform extends Platform {
  getIntfsDownForMTU() {
    return ["eth1", "eth2"];
  }
}

describe('Test platform setMTU', function(){
  this.timeout(30000);

  const origReadFile = fsp.readFile;
  const origGetSensor = sensorLoader.getSensor;
  let slaves;
  let ifplugCalls;

  beforeEach(() => {
    stub.reset();
    slaves = {};
    ifplugCalls = [];
    fsp.readFile = async (path) => {
      const m = path.match(/^\/sys\/class\/net\/([^/]+)\/bonding\/slaves$/);
      if (m && slaves[m[1]] !== undefined)
        return slaves[m[1]];
      throw new Error(`ENOENT ${path}`);
    };
    sensorLoader.getSensor = (name) => name === "IfPlugSensor" ? {
      stopMonitoringInterface: async (intf) => { ifplugCalls.push(`stop ${intf}`); },
      startMonitoringInterface: async (intf) => { ifplugCalls.push(`start ${intf}`); },
    } : null;
  });
  afterEach(() => {
    fsp.readFile = origReadFile;
    sensorLoader.getSensor = origGetSensor;
  });

  it('should set the MTU directly on a platform with no such interfaces', async()=> {
    slaves.bond0 = "eth1 eth2\n";
    await new Platform().setMTU("bond0", 3000);
    expect(stub.calls).to.eql(["sudo ip link set bond0 mtu 3000"]);
  });

  it('should bring a listed interface down around its own MTU change', async()=> {
    await new DownForMTUPlatform().setMTU("eth1", 3000);
    expect(stub.calls).to.eql([
      "sudo ip link set eth1 down",
      "sudo ip link set eth1 mtu 3000",
      "sudo ip link set eth1 up",
    ]);
    expect(ifplugCalls).to.eql(["stop eth1", "start eth1"]);
  });

  it('should leave other interfaces up', async()=> {
    await new DownForMTUPlatform().setMTU("eth3", 3000);
    expect(stub.calls).to.eql(["sudo ip link set eth3 mtu 3000"]);
    expect(ifplugCalls).to.eql([]);
  });

  it('should bring the listed slaves of a bond down around the bond MTU change', async()=> {
    slaves.bond0 = "eth2 eth3 eth1\n";
    await new DownForMTUPlatform().setMTU("bond0", 3000);
    expect(stub.calls).to.eql([
      "sudo ip link set eth2 down",
      "sudo ip link set eth1 down",
      "sudo ip link set bond0 mtu 3000",
      "sudo ip link set eth2 up",
      "sudo ip link set eth1 up",
    ]);
    expect(ifplugCalls).to.eql(["stop eth2", "stop eth1", "start eth2", "start eth1"]);
  });

  it('should set the MTU directly on a bond with no listed slaves', async()=> {
    slaves.bond1 = "\n";
    await new DownForMTUPlatform().setMTU("bond1", 3000);
    expect(stub.calls).to.eql(["sudo ip link set bond1 mtu 3000"]);
  });

  it('should bring the slaves back up when bringing one down fails', async()=> {
    slaves.bond0 = "eth1 eth2\n";
    stub.failOn("eth2 down");
    let err = null;
    await new DownForMTUPlatform().setMTU("bond0", 3000).catch(e => { err = e; });
    expect(err).to.not.be.null;
    expect(stub.matching("mtu")).to.eql([]);
    expect(stub.calls.slice(-2)).to.eql(["sudo ip link set eth1 up", "sudo ip link set eth2 up"]);
    expect(ifplugCalls.slice(-2)).to.eql(["start eth1", "start eth2"]);
  });

  it('should bring the slaves back up when the MTU change fails', async()=> {
    slaves.bond0 = "eth1 eth2\n";
    stub.failOn("mtu 3000");
    await new DownForMTUPlatform().setMTU("bond0", 3000);
    expect(stub.calls.slice(-2)).to.eql(["sudo ip link set eth1 up", "sudo ip link set eth2 up"]);
  });

  it('should list the interfaces that need the link down on GSE, Gold Plus 2 and Purple', async()=> {
    const expected = {gse: ["eth1", "eth2"], goldplus2: ["eth1", "eth2"], purple: ["eth0"]};
    const files = {gse: "GSEPlatform.js", goldplus2: "GoldPlus2Platform.js", purple: "PurplePlatform.js"};
    for (const p of Object.keys(expected)) {
      const Klass = stub.load(require.resolve(`../../platform/${p}/${files[p]}`));
      expect(new Klass().getIntfsDownForMTU(), p).to.eql(expected[p]);
    }
  });
});
