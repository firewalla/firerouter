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
 */

'use strict'

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const updateRouteScript = path.join(
  repoRoot,
  'scripts/firerouter_dhcpcd_update_rt'
);


describe('DHCPv6 Router Advertisement IPv6 gateway identity', () => {
  it(
    'withdraws the cached router when a zero-lifetime RA uses an equivalent expanded IPv6 spelling',
    () => {
      const sandboxDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'firerouter-dhcpcd-ipv6-equality-')
      );
      const stateDir = path.join(sandboxDir, 'state');
      const binDir = path.join(sandboxDir, 'bin');
      const eventLog = path.join(sandboxDir, 'events.log');
      const ipLog = path.join(sandboxDir, 'ip.log');

      try {
        fs.mkdirSync(stateDir);
        fs.mkdirSync(binDir);

        const sandboxHook = path.join(sandboxDir, 'update_rt');
        const hookContent = fs.readFileSync(updateRouteScript, 'utf8')
          .split('/dev/shm')
          .join(stateDir);
        fs.writeFileSync(sandboxHook, hookContent);

        fs.writeFileSync(
          path.join(stateDir, 'dhcpcd.ra.wan0'),
          'ra_router_lifetime=0\n'
        );
        fs.writeFileSync(
          path.join(stateDir, 'dhcpcd.gw6.wan0'),
          'fe80::a\n'
        );
        fs.writeFileSync(
          path.join(stateDir, 'dhcpcd.ip6.wan0'),
          ',\n'
        );
        fs.writeFileSync(eventLog, '');
        fs.writeFileSync(ipLog, '');

        fs.writeFileSync(
          path.join(binDir, 'redis-cli'),
          '#!/bin/sh\nprintf "%s\\n" "$*" >> "$EVENT_LOG"\n',
          { mode: 0o755 }
        );

        const runner = path.join(sandboxDir, 'run-hook');
        fs.writeFileSync(
          runner,
          `#!/bin/sh
reason=ROUTERADVERT
interface=wan0
default_rt_tables=main
rt_tables=main
RECORD_LEASE_GW6=fe80:0:0:0:0:0:0:a
RECORD_LEASE_ND_ID=1
EVENT_LOG=${eventLog}
IP_LOG=${ipLog}
export EVENT_LOG
PATH=${binDir}:$PATH
export PATH

log() {
  printf '%s\\n' "$*" >> "$EVENT_LOG"
}

execute_and_log() {
  "$@"
}

sudo() {
  "$@"
}

ip() {
  printf '%s\\n' "$*" >> "$IP_LOG"

  if [ "$1" = "-6" ] &&
     [ "$2" = "route" ] &&
     [ "$3" = "show" ] &&
     [ "$4" = "table" ] &&
     [ "$5" = "main" ] &&
     [ "$6" = "default" ] &&
     [ "$7" = "via" ] &&
     [ "$8" = "fe80::a" ] &&
     [ "$9" = "dev" ] &&
     [ "\${10}" = "wan0" ]; then
    echo "default via fe80::a dev wan0"
  fi

  return 0
}

. ${sandboxHook}
`
        );
        fs.chmodSync(runner, 0o755);

        execFileSync('/bin/sh', [runner], { stdio: 'pipe' });

        assert.strictEqual(
          fs.existsSync(path.join(stateDir, 'dhcpcd.gw6.wan0')),
          false
        );

        const ipOutput = fs.readFileSync(ipLog, 'utf8');
        assert.match(
          ipOutput,
          /-6 route show table main default via fe80::a dev wan0/
        );
        assert.match(
          ipOutput,
          /-6 r del default via fe80::a dev wan0 table main/
        );

        const eventOutput = fs.readFileSync(eventLog, 'utf8');
        assert.match(
          eventOutput,
          /router lifetime is 0 for managed router fe80:0:0:0:0:0:0:a/
        );
        assert.doesNotMatch(eventOutput, /non-managed router/);
        assert.match(eventOutput, /dhcpcd6\.ip_change/);
      } finally {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
      }
    }
  );
});
