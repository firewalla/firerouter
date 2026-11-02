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

'use strict'

const EventEmitter = require('events');
const childProcess = require('child_process');
const expect = require('chai').expect;

const { parseSsidTempDisabled } = require('../../util/wpa_cli.js');

// a fresh copy of util/wpa_cli.js whose spawn returns a fake child, it captures spawn at load
function loadWithFakeSpawn() {
  const modPath = require.resolve('../../util/wpa_cli.js');
  const cached = require.cache[modPath];
  const origSpawn = childProcess.spawn;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.written = [];
  child.stdin.write = (data, cb) => { child.stdin.written.push(data); cb && cb(); };
  childProcess.spawn = (cmd, args) => { child.cmd = [cmd].concat(args); return child; };
  delete require.cache[modPath];
  try {
    return { mod: require(modPath), child };
  } finally {
    childProcess.spawn = origSpawn;
    require.cache[modPath] = cached;
  }
}

describe('Test wpa_cli helper', function() {

  describe('parseSsidTempDisabled', () => {
    it('should parse a wrong key event', () => {
      const line = '<3>CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="lab" auth_failures=1 duration=10 reason=WRONG_KEY';
      expect(parseSsidTempDisabled(line)).to.eql({ id: '0', reason: 'WRONG_KEY' });
    });

    it('should parse EAP and connection failures behind a prompt', () => {
      expect(parseSsidTempDisabled('> <3>CTRL-EVENT-SSID-TEMP-DISABLED id=12 ssid="corp net" auth_failures=2 duration=20 reason=AUTH_FAILED'))
        .to.eql({ id: '12', reason: 'AUTH_FAILED' });
      expect(parseSsidTempDisabled('<3>CTRL-EVENT-SSID-TEMP-DISABLED id=3 ssid="x" auth_failures=1 duration=10 reason=CONN_FAILED  '))
        .to.eql({ id: '3', reason: 'CONN_FAILED' });
    });

    it('should take the reason from the end even if the ssid contains reason=', () => {
      const line = '<3>CTRL-EVENT-SSID-TEMP-DISABLED id=1 ssid="a reason=WRONG_KEY b" auth_failures=1 duration=10 reason=CONN_FAILED';
      expect(parseSsidTempDisabled(line)).to.eql({ id: '1', reason: 'CONN_FAILED' });
    });

    it('should ignore other lines and truncated events', () => {
      expect(parseSsidTempDisabled('<3>CTRL-EVENT-SSID-REENABLED id=0 ssid="lab"')).to.be.null;
      expect(parseSsidTempDisabled('<3>CTRL-EVENT-SCAN-RESULTS ')).to.be.null;
      expect(parseSsidTempDisabled('<3>CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="la')).to.be.null;
      expect(parseSsidTempDisabled('> PONG')).to.be.null;
    });
  });

  describe('spawnWpaCliInteractive', () => {
    it('should spawn wpa_cli on the control socket behind timeout and stdbuf', () => {
      const { mod, child } = loadWithFakeSpawn();
      mod.spawnWpaCliInteractive({ wpaCliPath: '/sbin/wpa_cli', socketDir: '/run/wpa/wlan0', intf: 'wlan0', timeout: '45s', onLine: () => {} });
      expect(child.cmd).to.eql(['sudo', 'timeout', '45s', 'stdbuf', '-o0', '-e0', '/sbin/wpa_cli', '-p', '/run/wpa/wlan0', '-i', 'wlan0']);
    });

    it('should hand over every line of a chunk, prompt included, by default', () => {
      const { mod, child } = loadWithFakeSpawn();
      const lines = [];
      mod.spawnWpaCliInteractive({ wpaCliPath: 'w', socketDir: 's', intf: 'i', timeout: '1s', onLine: l => lines.push(l) });
      child.stdout.emit('data', Buffer.from('bssid / frequency\r\n  aa:bb\t2412\t-40\t[ESS]\tMyWiFi \n> '));
      expect(lines).to.eql(['bssid / frequency', 'aa:bb\t2412\t-40\t[ESS]\tMyWiFi ', '> ']);
    });

    it('should join lines split across chunks with completeLines', () => {
      const { mod, child } = loadWithFakeSpawn();
      const lines = [];
      mod.spawnWpaCliInteractive({ wpaCliPath: 'w', socketDir: 's', intf: 'i', timeout: '1s', completeLines: true, onLine: l => lines.push(l) });
      child.stdout.emit('data', Buffer.from('> PONG\n<3>CTRL-EVENT-SSID-TEMP-DISABLED id=0'));
      child.stdout.emit('data', Buffer.from(' ssid="lab" auth_failures=1 duration=10 reason=WRONG_KEY\r\n> '));
      expect(lines).to.eql(['> PONG', '<3>CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="lab" auth_failures=1 duration=10 reason=WRONG_KEY']);
    });

    it('should write commands with a newline and survive a stdin error', () => {
      const { mod, child } = loadWithFakeSpawn();
      const cli = mod.spawnWpaCliInteractive({ wpaCliPath: 'w', socketDir: 's', intf: 'i', timeout: '1s', onLine: () => {} });
      cli.write('ping');
      cli.quit();
      expect(child.stdin.written).to.eql(['ping\n', 'quit\n']);
      child.stdin.emit('error', new Error('write EPIPE'));
      child.stdin.writable = false;
      cli.quit();
      expect(child.stdin.written).to.have.length(2);
    });
  });
});
