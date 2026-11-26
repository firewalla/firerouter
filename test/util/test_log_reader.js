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

'use strict'

// Off-box: the tail command LogReader runs

let chai = require('chai');
let expect = chai.expect;

const cp = require('child_process');
const {PassThrough} = require('stream');
const EventEmitter = require('events');

describe('Test LogReader', function() {
  const origSpawn = cp.spawn;
  const readerPath = require.resolve('../../util/LogReader.js');
  let spawned;
  let LogReader;

  before(() => {
    // LogReader takes spawn when it is required
    cp.spawn = (cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      spawned.push({cmd, args, child});
      return child;
    };
    delete require.cache[readerPath];
    LogReader = require(readerPath);
  });
  after(() => {
    cp.spawn = origSpawn;
    delete require.cache[readerPath];
  });
  beforeEach(() => {
    spawned = [];
  });

  it('replays the last lines of the file by default', () => {
    new LogReader('/var/log/kern.log', true).watch();
    new LogReader('/var/log/rtw.log').watch();
    expect(spawned.map(s => [s.cmd].concat(s.args))).to.eql([
      ["sudo", "tail", "-F", "/var/log/kern.log"],
      ["tail", "-F", "/var/log/rtw.log"],
    ]);
  });

  it('reads only new lines from the end of the file', async() => {
    const lines = [];
    const reader = new LogReader('/var/log/wpa_supplicant.log', true, true);
    reader.on('line', (line) => lines.push(line));
    reader.watch();
    expect([spawned[0].cmd].concat(spawned[0].args)).to.eql(["sudo", "tail", "-n", "0", "-F", "/var/log/wpa_supplicant.log"]);
    spawned[0].child.stdout.write("wlan0: CTRL-EVENT-CONNECTED\n");
    await new Promise(resolve => setImmediate(resolve));
    expect(lines).to.eql(["wlan0: CTRL-EVENT-CONNECTED"]);
  });
});
