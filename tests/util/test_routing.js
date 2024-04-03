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

  it('should constructor route rule class', () => {
    const rules = [
        'default via 192.168.10.254 dev eth0.288 metric 1',
        '10.89.18.0/24 dev wg_ap proto kernel scope link src 10.89.18.1',
        '10.89.18.195 dev wg_ap scope link metric 14',
        'broadcast 192.168.99.255 dev eth0 proto kernel scope link src 192.168.99.35',
        '2409:871e:2700:20::/64 dev bond0 proto kernel metric 256 pref medium',
        '::1 dev lo proto kernel metric 256 pref medium',
    ]
    const expectRules = [
        new routing.RouteRule({gateway: '192.168.10.254', interface: 'eth0.288', metric: 1, tableName: 'global_default', dest: 'default'}),
        new routing.RouteRule({interface: 'wg_ap', tableName: 'global_default', dest: '10.89.18.0/24', proto: 'kernel', scope: 'link', src: '10.89.18.1'}),
        new routing.RouteRule({dest: '10.89.18.195', interface: 'wg_ap', scope: 'link', metric:14, tableName: 'global_default'}),
        new routing.RouteRule({type: 'broadcast', dest: '192.168.99.255', interface: 'eth0', proto: 'kernel', scope: 'link', src: '192.168.99.35', tableName: 'global_default'}),
        new routing.RouteRule({dest: '2409:871e:2700:20::/64', interface: 'bond0', proto: 'kernel', metric: 256, tableName: 'global_default'}),
        new routing.RouteRule({dest: '::1', interface: 'lo', proto: 'kernel', metric: 256, tableName: 'global_default'}),
 
    ]
    for (let i=0; i<rules.length; i++) {
        const rule = new routing.RouteRule({tableName: 'global_default'});
        rule.parse(rules[i])
        expect(rule.type).to.equal(expectRules[i].type);
        expect(rule.interface).to.equal(expectRules[i].interface);
        expect(rule.gateway).to.equal(expectRules[i].gateway);
        expect(rule.metric).to.equal(expectRules[i].metric);
        expect(rule.tableName).to.equal(expectRules[i].tableName);
        expect(rule.scope).to.equal(expectRules[i].scope);
        expect(rule.dest).to.equal(expectRules[i].dest);
        expect(rule.proto).to.equal(expectRules[i].proto);
    }
  })

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


  it('should get raw rules', async() => {
    const input = [
      {intf: 'eth0.288', tableName: 'global_default'},
      {gateway: '10.88.8.1', intf: 'eth0.288', tableName: 'global_default', af: 4},
      {gateway: '10.88.8.1', intf: 'eth0.288', tableName: 'global_default', metric: 223, af: 4},
      {intf: 'eth0.288', tableName: 'main'},
    ];
    const expects = [
      [new routing.RouteRule({tableName: 'global_default', interface: 'eth0.288', gateway: undefined, scope: 'link', dest: '10.88.8.0/30', af: 4, parsed: true}),
      new routing.RouteRule({tableName: 'global_default', interface: 'eth0.288', gateway: '10.88.8.1', dest: '10.88.8.3', metric: 223, af:4, parsed: true})],
      [new routing.RouteRule({tableName: 'global_default', interface: 'eth0.288', gateway: '10.88.8.1', dest: "10.88.8.3", metric: 223, af: 4, parsed: true})],
      [new routing.RouteRule({tableName: 'global_default', interface: 'eth0.288', gateway: '10.88.8.1', dest: "10.88.8.3", metric: 223, af: 4, parsed: true})], [],
    ];

    for (let i=0; i<input.length; i++) {
      const rules = await routing.getParsedRouteRules(input[i].dest, input[i].gateway, input[i].intf, input[i].tableName, input[i].af);
      expect(rules).to.be.eql(expects[i]);
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
