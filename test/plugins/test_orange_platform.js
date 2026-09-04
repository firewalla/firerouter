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

'use strict';

const path = require('path');
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

const chai = require('chai');
const expect = chai.expect;

const OrangePlatform = require('../../platform/orange/OrangePlatform.js');

describe('OrangePlatform STA attempted SSIDs', function () {
  let platform;
  let stateAutomata;

  beforeEach(() => {
    platform = Object.create(OrangePlatform.prototype);
    stateAutomata = {
      attemptedSSIDs: new Set(),
    };
  });

  it('bounds attempted SSID history and evicts the oldest entry', function () {
    for (let i = 0; i < 128; i++) {
      platform._rememberAttemptedSSID(stateAutomata, `ssid-${i}`);
    }

    expect(stateAutomata.attemptedSSIDs.size).to.equal(128);
    expect(stateAutomata.attemptedSSIDs.has('ssid-0')).to.equal(true);

    platform._rememberAttemptedSSID(stateAutomata, 'ssid-128');

    expect(stateAutomata.attemptedSSIDs.size).to.equal(128);
    expect(stateAutomata.attemptedSSIDs.has('ssid-0')).to.equal(false);
    expect(stateAutomata.attemptedSSIDs.has('ssid-1')).to.equal(true);
    expect(stateAutomata.attemptedSSIDs.has('ssid-128')).to.equal(true);
  });

  it('does not grow the history when the SSID was already attempted', function () {
    for (let i = 0; i < 128; i++) {
      platform._rememberAttemptedSSID(stateAutomata, `ssid-${i}`);
    }

    platform._rememberAttemptedSSID(stateAutomata, 'ssid-127');

    expect(stateAutomata.attemptedSSIDs.size).to.equal(128);
    expect(stateAutomata.attemptedSSIDs.has('ssid-0')).to.equal(true);
    expect(stateAutomata.attemptedSSIDs.has('ssid-127')).to.equal(true);
  });
});
