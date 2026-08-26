/*    Copyright 2016-2026 Firewalla Inc.
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

const exec = require('child-process-promise').exec;
let log = require('../../util/logger.js')(__filename, 'info');
let routing = require('../../util/routing.js');

describe('Test routing', function(){
  this.timeout(30000);

  before(async () => {
        this.needClean = false;
        let result = await exec("sudo ip link show eth0.288").then( r => r.stdout).catch((err) => {log.debug(err.stderr);});
        if (result && result !== "") {
            log.warn("dev eth0.288 conflict, skip test");
            return;
        }
        result = await exec("sudo ip link add link eth0 name eth0.288 type vlan id 288").then(r => r.stderr).catch((err) => {log.error(err.stderr);});
        if (result === '') {
            this.needClean = true;
            await exec("sudo ip addr add 10.88.8.1/32 dev eth0.288").catch((err) => {log.error("add dev", err.stderr);});
            await exec("sudo ip link set dev eth0.288 up").catch((err) => {log.error("set dev up", err.stderr);});
            await exec("sudo ip route add table global_default 10.88.8.0/30 dev eth0.288").catch((err) => {log.error("add route", err.stderr);});
            await exec("sudo ip route add table global_default 10.88.8.3/32 via 10.88.8.1 metric 223").catch((err) => {log.error("add route", err.stderr);});
        }
  });

  after(async () => {
        if (this.needClean) {
            await exec("sudo ip route flush dev eth0.288 table global_default").catch((err) => {});
            await exec("sudo ip link set dev eth0.288 down").catch((err) => {});
            await exec("sudo ip addr del 10.88.8.1/32 dev eth0.288").catch((err) => {});
            await exec("sudo ip link del eth0.288").catch((err) => {});
        }    
  });


  it('should get device route rules', async()=> {
    const input = [
      {intf: 'eth0.288', tableName: 'global_default'},
      {gateway: '10.88.8.1', intf: 'eth0.288', tableName: 'global_default', af: 4},
      {gateway: '10.88.8.1', intf: 'eth0.288', tableName: 'global_default', metric: 223, af: 4},
      {intf: 'eth0.288', tableName: 'main'},
    ];
    const expects = [
      ['10.88.8.0/30 scope link', '10.88.8.3 via 10.88.8.1 metric 223'],
      ['10.88.8.3 metric 223'], ['10.88.8.3'], [],
    ];

    for (let i=0; i<input.length; i++) {
      const results = await routing.searchRouteRules(input[i].dest, input[i].gateway, input[i].intf, input[i].tableName, input[i].metric, input[i].af);
      expect(results).to.eql(expects[i]);
    }
  });
  

  it('should not get device route rules', async()=> {
    const results = await routing.searchRouteRules(null, null, 'eth0.289', 'global_default');
    expect(results).to.be.empty;
  });

  it('should format route rules', () => {
    const input = [{},{dest: '10.89.18.195'}, {gateway: '10.88.8.1'}, {intf: 'eth0'}, {tableName: 'main'}, {af: 6},
      {dest:'default', gateway:'10.88.8.1', intf: 'eth0.288', tableName: 'global_default', metric:223, af:4},
    ];
    const expects = ['ip -4 route show', 'ip -4 route show 10.89.18.195', 'ip -4 route show via 10.88.8.1',
      'ip -4 route show dev eth0', 'ip -4 route show table main', 'ip -6 route show',
      'ip -4 route show table global_default default dev eth0.288 via 10.88.8.1 metric 223'];

    for (let i=0; i < input.length; i++) {
      const output = routing.formatGetRouteCommand(input[i].dest, input[i].gateway, input[i].intf, input[i].tableName, input[i].metric, input[i].af);
      expect(output).to.be.equal(expects[i]);
    }
  });

  it ('should remove device rule', async() => {
    let results = await routing.searchRouteRules(null, null, 'eth0.288', 'global_default');
    expect(results.length).to.be.equal(2);

    await routing.removeDeviceRouteRule('eth0.288', 'global_default').catch((err) => {log.debug(err.stderr)});

    results = await routing.searchRouteRules(null, null, 'eth0.288', 'global_default');
    expect(results.length).to.be.equal(0);
  });

});

// These assert on the command that would be run rather than running it, so they need no device.
// routing.js captures exec/execFile when it is loaded, so the stubs go in before the module is
// re-required, and the module is dropped again afterwards to leave the real one for other files.
describe('Test routing command construction', function(){
  this.timeout(30000);

  const cpp = require('child-process-promise');
  const execFileCalls = [];
  const execCalls = [];
  let origExec, origExecFile, stubbedRouting;

  const PAYLOAD = "1.2.3.4; touch /tmp/pwn #";

  before(() => {
    origExec = cpp.exec;
    origExecFile = cpp.execFile;
    cpp.execFile = (file, args) => {
      execFileCalls.push({file, args});
      return Promise.resolve({stdout: "", stderr: ""});
    };
    cpp.exec = (cmd) => {
      execCalls.push(cmd);
      return Promise.resolve({stdout: "", stderr: ""});
    };
    delete require.cache[require.resolve('../../util/routing.js')];
    stubbedRouting = require('../../util/routing.js');
  });

  after(() => {
    cpp.exec = origExec;
    cpp.execFile = origExecFile;
    delete require.cache[require.resolve('../../util/routing.js')];
  });

  beforeEach(() => {
    execFileCalls.length = 0;
    execCalls.length = 0;
  });

  describe('addRouteToTable', function(){
    it('should build an argv array instead of a shell string', async()=> {
      await stubbedRouting.addRouteToTable("default", "192.168.1.1", "eth0", "eth0_default");
      expect(execFileCalls.length).to.be.equal(1);
      const call = execFileCalls[0];
      log.debug("route argv", call);
      expect(call.file).to.be.equal("sudo");
      expect(call.args[0]).to.be.equal("ip");
      expect(call.args).to.include("via");
      expect(call.args).to.include("192.168.1.1");
      expect(call.args).to.include("dev");
      expect(call.args).to.include("eth0");
      // nothing may be handed to a shell
      expect(execCalls.length).to.be.equal(0);
    });

    it('should keep an injected gateway as a single inert argument', async()=> {
      await stubbedRouting.addRouteToTable("default", PAYLOAD, "eth0", "eth0_default");
      const call = execFileCalls[0];
      // the payload survives verbatim as ONE element, so no shell ever splits it on ';'
      expect(call.args).to.include(PAYLOAD);
      expect(call.args.filter(a => a.includes("touch")).length).to.be.equal(1);
      expect(execCalls.length).to.be.equal(0);
    });

    it('should keep an injected destination as a single inert argument', async()=> {
      await stubbedRouting.addRouteToTable(PAYLOAD, null, "eth0", "eth0_default");
      expect(execFileCalls[0].args).to.include(PAYLOAD);
      expect(execCalls.length).to.be.equal(0);
    });
  });

  describe('addMultiPathRouteToTable', function(){
    it('should build an argv array for a valid nexthop', async()=> {
      await stubbedRouting.addMultiPathRouteToTable("default", "global_default", 4, 1,
        {nextHop: "192.168.1.1", dev: "eth0", weight: 5});
      expect(execFileCalls.length).to.be.equal(1);
      const args = execFileCalls[0].args;
      log.debug("multipath argv", args);
      expect(execFileCalls[0].file).to.be.equal("sudo");
      expect(args).to.include("nexthop");
      expect(args).to.include("weight");
      expect(args[args.indexOf("weight") + 1]).to.be.equal("5");
      expect(execCalls.length).to.be.equal(0);
    });

    it('should drop a nexthop whose weight is not a number', async()=> {
      await stubbedRouting.addMultiPathRouteToTable("default", "global_default", 4, 1,
        {nextHop: "192.168.1.1", dev: "eth0", weight: "1 ; id > /tmp/pwn ;"});
      const args = execFileCalls[0].args;
      // the whole nexthop is skipped, so the payload never becomes an argument at all
      expect(args).to.not.include("nexthop");
      expect(args.filter(a => String(a).includes("id >")).length).to.be.equal(0);
      expect(execCalls.length).to.be.equal(0);
    });

    it('should drop a weight outside the range ip route accepts', async()=> {
      for (const weight of [0, -1, 256, 1.5]) {
        execFileCalls.length = 0;
        await stubbedRouting.addMultiPathRouteToTable("default", "global_default", 4, 1,
          {nextHop: "192.168.1.1", dev: "eth0", weight});
        expect(execFileCalls[0].args, `weight ${weight}`).to.not.include("nexthop");
      }
    });

    it('should keep valid nexthops when one of several is rejected', async()=> {
      await stubbedRouting.addMultiPathRouteToTable("default", "global_default", 4, 1,
        {nextHop: "192.168.1.1", dev: "eth0", weight: 10},
        {nextHop: "192.168.2.1", dev: "eth1", weight: "; id"});
      const args = execFileCalls[0].args;
      expect(args).to.include("192.168.1.1");
      expect(args).to.not.include("192.168.2.1");
    });
  });
});
