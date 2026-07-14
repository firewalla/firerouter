/*    Copyright 2016-2024 Firewalla Inc.
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

  before((done) => (
    async() => {
        this.needClean = false;
        let result = await exec("sudo ip link show eth0.288").then( r => r.stdout).catch((err) => {log.debug(err.stderr);});
        if (result && result !== "") {
            log.warn("dev eth0.288 conflict, skip test");
            done();
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
        done();
    })()
  );

  after((done) => (
    async() => {
        if (this.needClean) {
            await exec("sudo ip route flush dev eth0.288 table global_default").catch((err) => {});
            await exec("sudo ip link set dev eth0.288 down").catch((err) => {});
            await exec("sudo ip addr del 10.88.8.1/32 dev eth0.288").catch((err) => {});
            await exec("sudo ip link del eth0.288").catch((err) => {});
        }    
        done();
    })()
  );


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
