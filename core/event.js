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

module.exports = {
  buildEvent: buildEvent,
  getEventType: getEventType,
  getEventPayload: getEventPayload,
  EVENT_IF_UP: "ifup",
  EVENT_IF_DOWN: "ifdown",
  EVENT_IP_CHANGE: "ipchange",
  EVENT_PD_CHANGE: "pdchange"
};