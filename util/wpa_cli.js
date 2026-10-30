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
const log = require('./logger.js')(__filename);

// Keep trailing spaces: SSID is the last field in scan_result output,
// so trim() would corrupt SSIDs like "MyWiFi ".
function splitLines(text) {
  return text.split('\n').map(line => line.replace(/\r$/, '').trimStart());
}

// Interactive wpa_cli attached to a control socket, it prints command replies and unsolicited
// <N>CTRL-EVENT-* lines on stdout. onLine gets every line of each stdout chunk, including the
// unterminated prompt at the end of a chunk, or with completeLines only newline-terminated lines.
function spawnWpaCliInteractive({ wpaCliPath, socketDir, intf, timeout, onLine, completeLines = false }) {
  const child = spawn('sudo', ['timeout', timeout, 'stdbuf', '-o0', '-e0', wpaCliPath, '-p', socketDir, '-i', intf]);
  // wpa_cli can exit before a write lands (no socket, timeout), an EPIPE must not crash the process
  child.stdin.on('error', err => {
    log.warn(`wpa_cli stdin on ${intf}:`, err.message);
  });

  let pending = '';
  // not using readline here as the final prompt after result won't be followed by line feed
  // readline will wait for that and cause a 5s delay
  child.stdout.on('data', data => {
    if (!data) return
    let text = data.toString();
    if (completeLines) {
      text = pending + text;
      const end = text.lastIndexOf('\n');
      pending = text.substring(end + 1);
      if (end < 0) return;
      text = text.substring(0, end);
    }
    for (const line of splitLines(text))
      onLine(line);
  });

  const write = (cmd, callback) => {
    child.stdin.writable && child.stdin.write(cmd + '\n', callback);
  };

  return { child, write, quit: (callback) => write('quit', callback) };
}

// wpa_supplicant gave up on a network for now, e.g.
// <3>CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="home" auth_failures=1 duration=10 reason=WRONG_KEY
function parseSsidTempDisabled(line) {
  if (!line.includes('CTRL-EVENT-SSID-TEMP-DISABLED'))
    return null;
  const id = line.match(/CTRL-EVENT-SSID-TEMP-DISABLED id=(\d+) /);
  // reason is the last field, anchor it so a quoted ssid containing "reason=" cannot match
  const reason = line.match(/ reason=([A-Z_]+)\s*$/);
  if (!id || !reason)
    return null;
  return { id: id[1], reason: reason[1] };
}

module.exports = {
  spawnWpaCliInteractive,
  parseSsidTempDisabled,
};
