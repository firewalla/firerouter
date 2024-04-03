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
let RoutingPlugin = require('../../plugins/routing/routing_plugin.js');
let InterfaceBasePlugin = require('../../plugins/interface/intf_base_plugin.js');


// path=routing {'routing': {...}} {"default":{"viaIntf":"eth0.204","type":"primary_standby","viaIntf2":"eth0","failback":true}}
const routingConfig =  {
  "default":
  {
      "viaIntf": "eth0.204",
      "type": "primary_standby",
      "viaIntf2": "eth0",
      "failback": true
  }
}

const routingConfig_fo = {
  "default":
  {
      "viaIntf": "eth0",
      "type": "primary_standby",
      "viaIntf2": "eth0.204",
      "failback": true
  }
}

describe('Test Routing WAN', function(){
  this.timeout(30000);

  before((done) => (
    async() => {
        this.plugin = new RoutingPlugin('routing');
        this.plugin.init({smooth_failover: true});
        this.needClean = false;
        let result = await exec("sudo ip link show eth0.288").then( r => r.stdout).catch((err) => {log.debug(err.stderr);});
        if (result && result !== "") {
            log.warn("dev eth0.288 conflict, skip prepare");
            done();
            return;
        }
        result = await exec("sudo ip link add link eth0 name eth0.288 type vlan id 288").then(r => r.stderr).catch((err) => {log.error(err.stderr);});
        if (result === '') {
            this.needClean = true;
            await exec("sudo ip addr add 10.88.8.1/32 dev eth0.288").catch((err) => {log.error("add dev", err.stderr);});
            await exec("sudo ip link set dev eth0.288 up").catch((err) => {log.error("set dev up", err.stderr);});
            await exec("sudo ip route add table eth0.288_default 10.88.8.0/30 dev eth0.288").catch((err) => {log.error("add route", err.stderr);});
            await exec("sudo ip route add table eth0.288_default 10.88.8.3/32 via 10.88.8.1 metric 223").catch((err) => {log.error("add route", err.stderr);});
            await exec("sudo ip route add table eth0.288_default 10.88.8.2/32 dev eth0.288 proto kernel scope link src 10.88.8.1").catch((err) => {log.error("add route", err.stderr);});
        }
        // fake wan interfaces
        this.plugin._wanStatus = {};
        this.plugin._wanStatus["eth0"] = {seq:1, ready: true, active: false, plugin: new InterfaceBasePlugin('eth0')};
        this.plugin._wanStatus["eth0.204"] = {seq:0, ready: true, active: true, plugin: new InterfaceBasePlugin('eth0.204')};
        this.plugin._wanStatus["eth0.288"] = {ready: false, active: false, plugin: new InterfaceBasePlugin('eth0.288')};
        done();
    })()
  );

  after((done) => (
    async() => {
        if (this.needClean) {
            await exec("sudo ip route flush table eth0.288_default dev eth0.288").catch((err) => {});
            await exec("sudo ip link set dev eth0.288 down").catch((err) => {});
            await exec("sudo ip addr del 10.88.8.1/32 dev eth0.288").catch((err) => {});
            await exec("sudo ip link del eth0.288").catch((err) => {});
        }
        done();
    })()
  );

  it.skip('should get unready WAN interfaces', () => {
    const deadWANs = this.plugin.getUnreadyWANPlugins();
    expect(deadWANs.length).to.be.equal(1);
    expect(deadWANs[0].name).to.be.equal('eth0.288');
  });

  it.skip('should remove dead route rules', async() => {
    let results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(3);

    await this.plugin._removeDeadRouting("eth0.288_default");

    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(0);
  });
  
  it.skip('should upsert route', async() => {
    await exec("sudo ip route add table eth0.288_default 10.88.8.0/30 dev eth0.288").catch((err) => {log.error("add route", err.stderr);});
    await exec("sudo ip route add table eth0.288_default 10.88.8.3/32 via 10.88.8.1").catch((err) => {log.error("add route", err.stderr);});
    await exec("sudo ip route add table eth0.288_default 10.88.8.3/32 via 10.88.8.1 metric 223").catch((err) => {log.error("add route", err.stderr);});

    let results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(3);

    await this.plugin.upsertRouteToTable('10.88.8.4/32', '10.88.8.1', 'eth0.288', 'eth0.288_default', 218);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(4);

    await this.plugin.upsertRouteToTable('10.88.8.3/32', '10.88.8.1', 'eth0.288', 'eth0.288_default', 289);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(3);

    await this.plugin.upsertRouteToTable('10.88.8.3/32', '10.88.8.1', 'eth0.288', 'eth0.288_default', 1);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(3);
    expect(results.includes('10.88.8.3 via 10.88.8.1 metric 1')).to.be.true;
    expect(results.includes('10.88.8.3 via 10.88.8.1 metric 289')).to.be.false;

    await this.plugin.upsertRouteToTable('10.88.8.3/32', '10.88.8.1', 'eth0.288', 'eth0.288_default', 1);
    expect(results.length).to.be.equal(3);
    expect(results.includes('10.88.8.3 via 10.88.8.1 metric 1')).to.be.true;
  });

  it.skip('should apply active global default routing', async() => {
    let results;

    this.plugin.networkConfig = routingConfig_fo;
    this.plugin._wanStatus['eth0.204'].ready = false;
    await this.plugin._applyActiveGlobalDefaultRouting(false, 4);
    results = await routing.searchRouteRules('default', null, null, 'main');
    expect(results.includes('default via 192.168.10.254 dev eth0.204 metric 101')).to.be.true;
    expect(results.includes('default via 192.168.203.1 dev eth0 metric 2')).to.be.true;

    this.plugin.networkConfig = routingConfig;
    this.plugin._wanStatus['eth0.204'].ready = true;
    await this.plugin._applyActiveGlobalDefaultRouting(false, 4);
    results = await routing.searchRouteRules('default', null, null, 'main');
    expect(results.includes('default via 192.168.10.254 dev eth0.204 metric 1')).to.be.true;
    expect(results.includes('default via 192.168.203.1 dev eth0 metric 2')).to.be.true;
  });

  it.skip('should remove route from table if dead', async() => {
    let results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(3);

    // remove by dest
    await this.plugin.removeRouteFromTableIfDead('10.88.8.4/32', null, null, 'eth0.288_default');
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(2);

    // remove by gateway
    await this.plugin.removeRouteFromTableIfDead('10.88.8.3/32', '10.88.8.1', null, 'eth0.288_default');
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(1);

    // remove by dev
    await this.plugin.removeRouteFromTableIfDead('10.88.8.0/30', null, 'eth0.288', 'eth0.288_default');
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(0);

    // will not remove active eth0
    results = await routing.searchRouteRules(null, null, 'eth0', 'global_default');
    const beforeCnt = results.length
    expect(beforeCnt).not.to.be.equal(0);

    await this.plugin.removeRouteFromTableIfDead('default', null, 'eth0', 'global_default');
    results = await routing.searchRouteRules(null, null, 'eth0', 'global_default');
    const afterCnt = results.length
    expect(beforeCnt).to.be.equal(afterCnt);

  });

  it('should update interface routes', async() => {
    await exec("sudo ip route flush table eth0.288_default dev eth0.288").catch((err) => {});

    await exec("sudo ip route add table eth0.288_default default dev eth0.288").catch((err) => {log.error("add route", err.stderr);});
    await exec("sudo ip route add table eth0.288_default 10.88.8.3/32 via 10.88.8.1 metric 223").catch((err) => {log.error("add route", err.stderr);});
    await exec("sudo ip route add table eth0.288_default 10.88.8.2/32 dev eth0.288 proto kernel scope link src 10.88.8.1").catch((err) => {log.error("add route", err.stderr);});

    let results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    log.debug("1. results", results)
    expect(results.length).to.be.equal(3);
 
    await this.plugin.updateGlobalRoutes('eth0.288');

    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    log.debug("2. results", results)
    expect(results.length).to.be.equal(3);
 
  });

});
