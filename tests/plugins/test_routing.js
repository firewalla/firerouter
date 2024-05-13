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
        let result = await exec("sudo ip link show eth0.288").then( r => r.stdout).catch((err) => {log.debug(err.stderr)});
        if (result && result !== "") {
            log.warn("dev eth0.288 conflict, skip prepare");
            done();
            return;
        }
        result = await exec("sudo ip link add link eth0 name eth0.288 type vlan id 288").then(r => r.stderr).catch((err) => {log.error(err.stderr)});
        if (result === '') {
            this.needClean = true;
            await exec("sudo ip addr add 10.88.8.1/32 dev eth0.288").catch((err) => {log.error("add dev", err.stderr)});
            await exec("sudo ip link set dev eth0.288 up").catch((err) => {log.error("set dev up", err.stderr)});
            await exec("ip route show table eth0.288_default").catch((err) => {log.error("show device route table", err.stderr)});
            await exec("sudo ip route add table eth0.288_default default via 10.88.8.1").catch((err) => {log.error("add route", err.stderr)});
            await exec("sudo ip route add table eth0.288_default 10.88.8.0/30 dev eth0.288").catch((err) => {log.error("add route", err.stderr)});
            await exec("sudo ip route add table eth0.288_default 10.88.8.3/32 via 10.88.8.1 metric 223").catch((err) => {log.error("add route", err.stderr)});
            await exec("sudo ip route add table eth0.288_default 10.88.8.2/32 dev eth0.288 proto kernel scope link src 10.88.8.1").catch((err) => {log.error("add route", err.stderr)});
        }
        // fake wan interfaces
        this.plugin._wanStatus = {};
        this.plugin._wanStatus["eth0"] = {seq:1, ready: true, active: false, plugin: new InterfaceBasePlugin('eth0')};
        this.plugin._wanStatus["eth0.204"] = {seq:0, ready: true, active: true, plugin: new InterfaceBasePlugin('eth0.204')};
        this.plugin._wanStatus["eth0.288"] = {ready: false, active: false, plugin: new InterfaceBasePlugin('eth0.288')};

        await exec("echo 'nameserver 10.8.8.8'  >> /home/pi/.router/run/eth0.288.resolv.conf").catch((err) => {log.error("add eth0.288 resolvconf err,", err.stderr)});
        await exec("echo 'nameserver 8.8.8.8'  >> /home/pi/.router/run/eth0.288.resolv.conf").catch((err) => {log.error("add eth0.288 resolvconf err,", err.stderr)});

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
            await exec("rm /home/pi/.router/run/eth0.288.resolv.conf").catch((err) => {log.error("rm eth0.288 resolvconf err,", err.stderr)});
        }
        done();
    })()
  );

  it('should get unready WAN interfaces', () => {
    const deadWANs = this.plugin.getUnreadyWANPlugins();
    expect(deadWANs.length).to.be.equal(1);
    expect(deadWANs[0].name).to.be.equal('eth0.288');
  });

  it('should remove dead device route rules', async() => {
    const deadWANs = this.plugin.getUnreadyWANPlugins();

    let results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(4);

    await this.plugin._removeDeviceRouting(deadWANs, "eth0.288_default");

    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(0);
  });

  it('should remove dead target route rules', async() => {
    await exec("sudo ip route flush table eth0.288_default dev eth0.288").catch((err) => {});
    await exec("sudo ip route add table eth0.288_default default via 10.88.8.1").catch((err) => {log.error("add route", err.message)});
    await exec("sudo ip route add table eth0.288_default 8.8.8.8 via 10.88.8.1 dev eth0.288 metric 101").catch((err) => {log.error("add route", err.message)});
    await exec("sudo ip route add table eth0.288_default 10.8.8.8  via 10.88.8.1 dev eth0.288 metric 101").catch((err) => {log.error("add route", err.message)});

    this.plugin._dnsRoutes = {"eth0.288":[
      {dest: '8.8.8.8', viaIntf: 'eth0.288', gw: '10.88.8.1', metric: 101, tableName: 'eth0.288_default'},
      {dest: '10.8.8.8', viaIntf: 'eth0.288', gw: '10.88.8.1', metric: 101, tableName: 'eth0.288_default'},
    ]};
    const deadWANs = this.plugin.getUnreadyWANPlugins();
    expect(deadWANs[0].name).to.be.equal('eth0.288');
    expect(await deadWANs[0].getDNSNameservers()).to.be.eql(['10.8.8.8', '8.8.8.8']);

    let results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(3);

    // remote default route of dev eth0.288
    await this.plugin._removeDeviceDefaultRouting(deadWANs, "eth0.288_default");
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(2);

    // remove dns routes
    await this.plugin._removeDeviceDnsRouting(deadWANs);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(0);
  });
  
  it('should upsert route', async() => {
    await exec("sudo ip route flush table eth0.288_default dev eth0.288").catch((err) => {});
    await exec("sudo ip route add table eth0.288_default default via 10.88.8.1").catch((err) => {log.error("add route", err.message)});
    await exec("sudo ip route add table eth0.288_default 10.88.8.0/30 dev eth0.288").catch((err) => {log.error("add route", err.message)});
    await exec("sudo ip route add table eth0.288_default 10.88.8.3/32 via 10.88.8.1").catch((err) => {log.error("add route", err.message)});
    await exec("sudo ip route add table eth0.288_default 10.88.8.3/32 via 10.88.8.1 metric 223").catch((err) => {log.error("add route", err.message)});

    let results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(4);

    await this.plugin.upsertRouteToTable('10.88.8.4/32', '10.88.8.1', 'eth0.288', 'eth0.288_default', 218);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(5);

    await this.plugin.upsertRouteToTable('10.88.8.3/32', '10.88.8.1', 'eth0.288', 'eth0.288_default', 289);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(4);

    await this.plugin.upsertRouteToTable('10.88.8.3/32', '10.88.8.1', 'eth0.288', 'eth0.288_default', 1);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(4);
    expect(results.includes('10.88.8.3 via 10.88.8.1 metric 1')).to.be.true;
    expect(results.includes('10.88.8.3 via 10.88.8.1 metric 289')).to.be.false;

    await this.plugin.upsertRouteToTable('10.88.8.3/32', '10.88.8.1', 'eth0.288', 'eth0.288_default', 1);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(4);
    expect(results.includes('10.88.8.3 via 10.88.8.1 metric 1')).to.be.true;

    await this.plugin.upsertRouteToTable('10.88.8.3/32', '10.88.8.3', 'eth0.288', 'eth0.288_default', 1);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(4);
    expect(results.includes('10.88.8.3 via 10.88.8.3 metric 1')).to.be.true;
    expect(results.includes('10.88.8.3 via 10.88.8.1 metric 1')).to.be.false;

    await this.plugin.upsertRouteToTable('10.88.8.3/32', '10.88.8.1', 'eth0.288', 'eth0.288_default', 199);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(4);
    expect(results.includes('10.88.8.3 via 10.88.8.1 metric 199')).to.be.true;
    expect(results.includes('10.88.8.3 via 10.88.8.3 metric 1')).to.be.false;

    await this.plugin.upsertRouteToTable('default', '10.88.8.3', 'eth0.288', 'eth0.288_default', 2);
    results = await routing.searchRouteRules(null, null, 'eth0.288', 'eth0.288_default');
    expect(results.length).to.be.equal(4);
    expect(results.includes('default via 10.88.8.3 metric 2')).to.be.true;
    expect(results.includes('default via 10.88.8.1')).to.be.false;

  });

  it('should apply active global default routing with smooth_failover', async() => {
    await this.plugin.upsertRouteToTable('default', '10.88.8.1', 'eth0.288', 'eth0.288_default', 2);
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

  it('should apply active global default routing without smooth_failover', async() => {
    let results;

    this.plugin.pluginConfig = {};
    this.plugin.networkConfig = routingConfig_fo;
    this.plugin._wanStatus['eth0.204'].ready = false;
    await this.plugin._applyActiveGlobalDefaultRouting(false, 4);
    results = await routing.searchRouteRules('default', null, null, 'main');
    expect(results.includes('default via 192.168.10.254 dev eth0.204 metric 101')).to.be.true;
    expect(results.includes('default via 192.168.203.1 dev eth0 metric 2')).to.be.true;

    results = await routing.searchRouteRules(null, null, 'eth0.204', 'main');
    expect(results.includes('192.168.10.0/24 proto kernel scope link src 192.168.10.135')).to.be.true;

    this.plugin.networkConfig = routingConfig;
    this.plugin._wanStatus['eth0.204'].ready = true;
    await this.plugin._applyActiveGlobalDefaultRouting(false, 4);
    results = await routing.searchRouteRules('default', null, null, 'main');
    expect(results.includes('default via 192.168.10.254 dev eth0.204 metric 1')).to.be.true;
    expect(results.includes('default via 192.168.203.1 dev eth0 metric 2')).to.be.true;
  });

  it('should get rule metric', () => {
    expect(this.plugin._getRouteRuleMetric('table eth0.288_default 10.88.8.0/30 dev eth0.288')).to.be.null;
    expect(this.plugin._getRouteRuleMetric('table eth0.288_default 10.88.8.0/30 dev eth0.288 metric 1')).to.be.equal('1');
    expect(this.plugin._getRouteRuleMetric('fe80::/64 dev eth0.204  via fe80::226d:31ff:fe01:2b43 metric 1024 pref medium')).to.be.equal('1024');
  });

  it('should get rule gateway', () => {
    expect(this.plugin._getRouteRuleGateway('table eth0.288_default 10.88.8.0/30 dev eth0.288')).to.be.null;
    expect(this.plugin._getRouteRuleGateway('table eth0.288_default via 10.88.8.1 10.88.8.0/30 dev eth0.288 metric 1')).to.be.equal('10.88.8.1');
    expect(this.plugin._getRouteRuleGateway('fe80::/64 dev eth0.204 via fe80::226d:31ff:fe01:2b43 metric 1024 pref medium')).to.be.equal('fe80::226d:31ff:fe01:2b43');
  });

  it('should update global interface routes', async() => {
    let beforeResults = await routing.searchRouteRules(null, null, 'eth0', 'main');

    await this.plugin.refreshGlobalIntfRoutes('eth0');

    let afterResults = await routing.searchRouteRules(null, null, 'eth0', 'main');
    expect(afterResults.length).to.be.equal(beforeResults.length);
  });

});
