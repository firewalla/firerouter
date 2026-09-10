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

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');

describe('DHCP command execution helper', function() {
  const scripts = [
    'firerouter_dhcpcd_common',
    'firerouter_dhclient_update_rt',
  ];

  for (const scriptName of scripts) {
    it(`passes arguments without evaluating shell metacharacters in ${scriptName}`, function() {
      const script = path.resolve(__dirname, `../scripts/${scriptName}`);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firerouter-dhcp-hook-'));
      const marker = path.join(tempDir, 'unexpected');

      try {
        const shellCode = [
          'log() { :; }',
          '. <(sed -n \'/^execute_and_log() {/,/^}/p\' "$1")',
          'execute_and_log printf "%s" "$2"',
        ].join('\n');

        const output = execFileSync(
          '/bin/bash',
          ['-c', shellCode, 'test', script, `safe; touch "${marker}"`],
          {encoding: 'utf8'}
        );

        assert.strictEqual(output, `safe; touch "${marker}"`);
        assert.strictEqual(fs.existsSync(marker), false);
      } finally {
        fs.rmSync(tempDir, {recursive: true, force: true});
      }
    });
  }
});
