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

const { spawn } = require('child_process');

// Keep trailing spaces: SSID is the last field in scan_result output,
// so trim() would corrupt SSIDs like "MyWiFi ".
function splitLines(text) {
  return text.split('\n').map(line => line.replace(/\r$/, '').trimStart());
}

// Interactive wpa_cli attached to a control socket, it prints command replies and unsolicited
// <N>CTRL-EVENT-* lines on stdout. onLine gets every line of each stdout chunk, including the
// unterminated prompt at the end of a chunk.
function spawnWpaCliInteractive({ wpaCliPath, socketDir, intf, timeout, onLine }) {
  const child = spawn('sudo', ['timeout', timeout, 'stdbuf', '-o0', '-e0', wpaCliPath, '-p', socketDir, '-i', intf]);

  // not using readline here as the final prompt after result won't be followed by line feed
  // readline will wait for that and cause a 5s delay
  child.stdout.on('data', data => {
    if (!data) return
    for (const line of splitLines(data.toString()))
      onLine(line);
  });

  const write = (cmd, callback) => {
    child.stdin.writable && child.stdin.write(cmd + '\n', callback);
  };

  return { child, write, quit: (callback) => write('quit', callback) };
}

module.exports = {
  spawnWpaCliInteractive,
};
