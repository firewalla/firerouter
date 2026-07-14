/*    Copyright 2021 Firewalla Inc.
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

'use strict';

const MSG_FR_CHANGE_APPLIED = "firerouter.change_applied";
const MSG_FR_IFACE_CHANGE_APPLIED = "firerouter.iface_change_applied";
const MSG_FR_APC_CHANGE_APPLIED = "firerouter.apc_change_applied";
const MSG_FR_WAN_CONN_CHANGED = "firerouter.wan_conn_changed";
const MSG_FR_WAN_STATE_CHANGED = "firerouter.wan_state_changed";
const MSG_FR_WAN_CONN_ANY_UP = "firerouter.wan_conn_any_up";
const MSG_FR_WAN_CONN_ALL_DOWN = "firerouter.wan_conn_all_down";
const MSG_FIRERESET_BLUETOOTH_CONTROL = "firereset.ble.control";

module.exports = {
  MSG_FR_CHANGE_APPLIED,
  MSG_FR_IFACE_CHANGE_APPLIED,
  MSG_FR_APC_CHANGE_APPLIED,
  MSG_FR_WAN_CONN_CHANGED,
  MSG_FR_WAN_STATE_CHANGED,
  MSG_FR_WAN_CONN_ALL_DOWN,
  MSG_FR_WAN_CONN_ANY_UP,
  MSG_FIRERESET_BLUETOOTH_CONTROL
}