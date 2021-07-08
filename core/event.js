/*    Copyright 2019 Firewalla Inc
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

function buildEvent(type, payload) {
  return {type: type, payload: payload};
}

function getEventType(event) {
  return event && event.type;
}

function getEventPayload(event) {
  return event && event.payload;
}

function suppressLogging(event) {
  event.logging = false;
}

function isLoggingSuppressed(event) {
  return event.logging === false;
}

module.exports = {
  buildEvent: buildEvent,
  getEventType: getEventType,
  getEventPayload: getEventPayload,
  suppressLogging: suppressLogging,
  isLoggingSuppressed: isLoggingSuppressed,
  EVENT_IF_UP: "ifup",
  EVENT_IF_DOWN: "ifdown",
  EVENT_WLAN_UP: "wlan_ip",
  EVENT_WLAN_DOWN: "wlan_down",
  EVENT_IP_CHANGE: "ipchange",
  EVENT_PD_CHANGE: "pdchange",
  EVENT_PPPOE_IPV6_UP: "pppoe_ipv6_up",
  EVENT_WAN_CONN_CHECK: "wan_conn_check",
  EVENT_WAN_SWITCHED: "wan_switched",
  EVENT_IF_PRESENT: "if_present",
  EVENT_IF_DISAPPEAR: "if_disappear"
};