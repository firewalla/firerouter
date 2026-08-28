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

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chai = require('chai');
const expect = chai.expect;

const repoRoot = path.resolve(__dirname, '../..');
const commonScript = path.join(repoRoot, 'scripts/firerouter_dhcpcd_common');
const updateRouteScript = path.join(repoRoot, 'scripts/firerouter_dhcpcd_update_rt');


function copyHookToSandbox(source, destination, stateDir) {
  const content = fs.readFileSync(source, 'utf8').split('/dev/shm').join(stateDir);
  fs.writeFileSync(destination, content);
}


describe('DHCPv6 Router Advertisement route updates', () => {
  let sandboxDir;
  let stateDir;
  let sudoLog;
  let eventLog;

  function createRunner({
    gateway,
    lifetime,
    routeExists = false,
  }) {
    const runner = path.join(
      sandboxDir,
      `run-hook-${gateway.replace(/:/g, '-')}`
    );

    const raFile = path.join(stateDir, 'dhcpcd.ra.wan0');

    fs.writeFileSync(
      raFile,
      `ra_router_lifetime=${lifetime}\n`
    );

    const routeOutput = routeExists
      ? 'default via fe80::a dev wan0\n'
      : '';

    fs.writeFileSync(
      runner,
      `#!/bin/bash

reason=ROUTERADVERT
interface=wan0
default_rt_tables=main
rt_tables=main
RECORD_LEASE_GW6=${gateway}
RECORD_LEASE_ND_ID=1

IP_LOG=${path.join(sandboxDir, 'ip.log')}
SUDO_LOG=${sudoLog}
EVENT_LOG=${eventLog}
RA_FILE=${raFile}

ip() {
  printf '%s\\\\n' "$*" >> "$IP_LOG"

  if [ "$1" = "-4" ]; then
    echo "inet 192.0.2.10/24"
    return 0
  fi

  if [ "$1" = "-6" ] && [ "$2" = "route" ] && [ "$3" = "show" ]; then
    printf '%s' '${routeOutput}'
    return 0
  fi

  if [ "$1" = "-6" ] && [ "$2" = "r" ] && [ "$3" = "del" ]; then
    return 0
  fi

  return 0
}

grep() {
  if [ "$1" = "-oP" ]; then
    sed -n 's/^ra_router_lifetime=//p' "$3"
  else
    command grep "$@"
  fi
}

sudo() {
  printf '%s\\\\n' "$*" >> "$SUDO_LOG"
  "$@"
}

redis-cli() {
  printf '%s\\\\n' "$*" >> "$EVENT_LOG"
}

source ${commonScript}

log() {
  printf '%s\\\\n' "$*" >> "$EVENT_LOG"
}

source ${path.join(sandboxDir, 'update_rt')}
`
    );

    fs.chmodSync(runner, 0o755);

    return runner;
  }

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'firerouter-dhcpcd-')
    );

    stateDir = path.join(sandboxDir, 'state');
    sudoLog = path.join(sandboxDir, 'sudo.log');
    eventLog = path.join(sandboxDir, 'event.log');

    fs.mkdirSync(stateDir);

    copyHookToSandbox(
      updateRouteScript,
      path.join(sandboxDir, 'update_rt'),
      stateDir
    );

    // Router A is the currently managed default router.
    fs.writeFileSync(
      path.join(stateDir, 'dhcpcd.gw6.wan0'),
      'fe80::a\n'
    );

    fs.writeFileSync(
      path.join(sandboxDir, 'ip.log'),
      ''
    );

    fs.writeFileSync(
      sudoLog,
      ''
    );

    fs.writeFileSync(
      eventLog,
      ''
    );
  });

  afterEach(() => {
    fs.rmSync(sandboxDir, {
      recursive: true,
      force: true
    });
  });

  it(
    'does not withdraw router A when different router B advertises a zero lifetime',
    () => {
      const runner = createRunner({
        gateway: 'fe80::b',
        lifetime: '0',
        routeExists: true,
      });

      execFileSync('bash', [runner], {
        stdio: 'pipe'
      });

      const cache = path.join(
        stateDir,
        'dhcpcd.gw6.wan0'
      );

      const sudoOutput = fs.readFileSync(
        sudoLog,
        'utf8'
      );

      const eventOutput = fs.readFileSync(
        eventLog,
        'utf8'
      );

      const ipOutput = fs.readFileSync(
        path.join(sandboxDir, 'ip.log'),
        'utf8'
      );

      // Confirm that the zero-lifetime path was actually exercised.
      expect(eventOutput).to.include(
        'ROUTERADVERT: router lifetime is 0 for non-managed router fe80::b'
      );

      // Router A remains the managed router.
      expect(fs.readFileSync(cache, 'utf8')).to.equal(
        'fe80::a\n'
      );

      // No IPv6 route deletion should occur.
      expect(sudoOutput).to.equal('');
      expect(sudoOutput).to.not.include('ip -6');

      // The route lookup used for the zero-lifetime cleanup path must also
      // not occur because B is not the currently managed router.
      expect(ipOutput).to.not.include('default');
    }
  );

  it(
    'withdraws the currently cached router when that router advertises a zero lifetime',
    () => {
      const runner = createRunner({
        gateway: 'fe80::a',
        lifetime: '0',
        routeExists: true,
      });

      execFileSync('bash', [runner], {
        stdio: 'pipe'
      });

      const cache = path.join(
        stateDir,
        'dhcpcd.gw6.wan0'
      );

      const sudoOutput = fs.readFileSync(
        sudoLog,
        'utf8'
      );

      const eventOutput = fs.readFileSync(
        eventLog,
        'utf8'
      );

      // The cached gateway must be cleared after successful withdrawal.
      expect(fs.existsSync(cache)).to.equal(false);

      // The managed default route must actually be deleted.
      expect(sudoOutput).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      // The route-state change must be reported.
      expect(eventOutput).to.include(
        'ip_changed: IPv6 default route state changed on wan0'
      );

      // The existing IPv6 change notification mechanism must fire.
      expect(eventOutput).to.include(
        'dhcpcd6.ip_change'
      );
    }
  );
});
