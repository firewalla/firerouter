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

'use strict';

const {expect} = require('chai');
const BridgeInterfacePlugin = require('../../plugins/interface/bridge_intf_plugin.js');

const BridgePortStateSync = BridgeInterfacePlugin.BridgePortStateSync;

describe('BridgePortStateSync', function() {
  it('ignores VLAN events for physical interfaces outside the monitored bridge', async function() {
    const sync = new BridgePortStateSync('br0', {
      warn() {},
      debug() {},
    });

    const monitorProcess = {};
    sync._monitorProcess = monitorProcess;
    sync._memberIntfs = new Set(['eth1', 'eth2']);

    const originalGetNativeBridgePortState = BridgePortStateSync.getNativeBridgePortState;
    const originalScheduleApply = sync._scheduleApply;

    let nativeStateCalls = 0;
    const scheduledStates = [];

    try {
      BridgePortStateSync.getNativeBridgePortState = async () => {
        nativeStateCalls++;
        return 3;
      };

      sync._scheduleApply = (physicalIntf, stateNum) => {
        scheduledStates.push({physicalIntf, stateNum});
      };

      sync._handleLine('5: eth0.100@eth0: <BROADCAST> master vbr100 state forwarding');

      await new Promise(resolve => setImmediate(resolve));

      expect(nativeStateCalls).to.equal(0);
      expect(scheduledStates).to.deep.equal([]);

      sync._handleLine('6: eth1.100@eth1: <BROADCAST> master vbr100 state forwarding');

      await new Promise(resolve => setImmediate(resolve));

      expect(nativeStateCalls).to.equal(1);
      expect(scheduledStates).to.deep.equal([
        {physicalIntf: 'eth1', stateNum: 3},
      ]);
    } finally {
      BridgePortStateSync.getNativeBridgePortState = originalGetNativeBridgePortState;
      sync._scheduleApply = originalScheduleApply;
    }
  });
});
