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
  let ipLog;

  function createRunner({
    gateway,
    lifetime,
    routeGateway = null,
  }) {
    const runner = path.join(
      sandboxDir,
      `run-hook-${gateway.replace(/:/g, '-')}`
    );

    const raFile = path.join(
      stateDir,
      'dhcpcd.ra.wan0'
    );

    fs.writeFileSync(
      raFile,
      `ra_router_lifetime=${lifetime}\n`
    );

    fs.writeFileSync(
      runner,
      `#!/bin/bash

reason=ROUTERADVERT
interface=wan0
default_rt_tables=main
rt_tables=main
RECORD_LEASE_GW6=${gateway}
RECORD_LEASE_ND_ID=1
mtu=1500
metric=1024

IP_LOG=${ipLog}
SUDO_LOG=${sudoLog}
EVENT_LOG=${eventLog}

ip() {
  printf '%s\\\\n' "$*" >> "$IP_LOG"

  # IPv4 address lookup used by the normal hook environment.
  if [ "$1" = "-4" ]; then
    if [ "$2" = "addr" ] && [ "$3" = "show" ] && [ "$4" = "dev" ]; then
      echo "inet 192.0.2.10/24"
      return 0
    fi
  fi

  # Route lookup used by the zero-lifetime cleanup path.
  if [ "$1" = "-6" ] && [ "$2" = "route" ] && [ "$3" = "show" ]; then
    requested_gateway=""

    if [ "$4" = "table" ] && [ "$5" = "main" ] &&
       [ "$6" = "default" ] && [ "$7" = "via" ]; then
      requested_gateway="$8"
    fi

    if [ "$requested_gateway" = "${routeGateway}" ]; then
      echo "default via ${routeGateway} dev wan0"
    fi

    return 0
  fi

  # The actual delete command is routed through sudo -> ip.
  if [ "$1" = "-6" ] && [ "$2" = "r" ] && [ "$3" = "del" ]; then
    return 0
  fi

  # Other commands are not expected in these regression tests.
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

    stateDir = path.join(
      sandboxDir,
      'state'
    );

    sudoLog = path.join(
      sandboxDir,
      'sudo.log'
    );

    eventLog = path.join(
      sandboxDir,
      'event.log'
    );

    ipLog = path.join(
      sandboxDir,
      'ip.log'
    );

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
      sudoLog,
      ''
    );

    fs.writeFileSync(
      eventLog,
      ''
    );

    fs.writeFileSync(
      ipLog,
      ''
    );
  });

  afterEach(() => {
    fs.rmSync(
      sandboxDir,
      {
        recursive: true,
        force: true
      }
    );
  });

  it(
    'does not withdraw router A when different router B advertises a zero lifetime',
    () => {
      const runner = createRunner({
        gateway: 'fe80::b',
        lifetime: '0',
        routeGateway: 'fe80::a',
      });

      execFileSync(
        'bash',
        [runner],
        {
          stdio: 'pipe'
        }
      );

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
        ipLog,
        'utf8'
      );

      /*
       * This proves the ROUTERADVERT zero-lifetime branch actually executed.
       * The test therefore cannot pass merely because the ROUTERADVERT case
       * is missing from update_rt.
       */
      expect(eventOutput).to.include(
        'ROUTERADVERT: router lifetime is 0 for non-managed router fe80::b'
      );

      /*
       * Router A remains the managed gateway.
       */
      expect(
        fs.readFileSync(cache, 'utf8')
      ).to.equal(
        'fe80::a\n'
      );

      /*
       * B's zero lifetime must not cause A's default route to be deleted.
       */
      expect(sudoOutput).to.not.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      expect(sudoOutput).to.not.include(
        'ip -6 r del default via fe80::b dev wan0 table main'
      );

      /*
       * No route lookup should be necessary because the selected router
       * is not the currently managed router.
       */
      expect(ipOutput).to.not.include(
        '-6 route show'
      );

      /*
       * No IPv6 change event should be published because routing state did
       * not change.
       */
      expect(eventOutput).to.not.include(
        'dhcpcd6.ip_change'
      );
    }
  );

  it(
    'withdraws the currently cached router when that router advertises a zero lifetime',
    () => {
      const runner = createRunner({
        gateway: 'fe80::a',
        lifetime: '0',
        routeGateway: 'fe80::a',
      });

      execFileSync(
        'bash',
        [runner],
        {
          stdio: 'pipe'
        }
      );

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
        ipLog,
        'utf8'
      );

      /*
       * A successful withdrawal clears the cached managed gateway.
       */
      expect(
        fs.existsSync(cache)
      ).to.equal(false);

      /*
       * The route lookup must have been performed against the cached router.
       */
      expect(ipOutput).to.include(
        '-6 route show table main default via fe80::a dev wan0'
      );

      /*
       * The managed default route must actually be deleted.
       */
      expect(sudoOutput).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      /*
       * The IPv6 routing state change must be reported.
       */
      expect(eventOutput).to.include(
        'ip_changed: IPv6 default route state changed on wan0'
      );

      /*
       * The existing IPv6 change notification must be published.
       */
      expect(eventOutput).to.include(
        'dhcpcd6.ip_change'
      );
    }
  );

  it(
    'installs a default route when the router lifetime is nonzero',
    () => {
      const runner = createRunner({
        gateway: 'fe80::b',
        lifetime: '1800',
      });

      execFileSync(
        'bash',
        [runner],
        {
          stdio: 'pipe'
        }
      );

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

      /*
       * Nonzero lifetime preserves the existing route-installation behavior.
       */
      expect(sudoOutput).to.include(
        'ip -6 r replace default via fe80::b dev wan0 mtu 1500 table main'
      );

      /*
       * The new router becomes the cached managed gateway.
       */
      expect(
        fs.readFileSync(cache, 'utf8')
      ).to.equal(
        'fe80::b\n'
      );

      /*
       * Changing the managed gateway is still reported as an IPv6 change.
       */
      expect(eventOutput).to.include(
        'ip_changed: gw6 changed from fe80::a to fe80::b on wan0'
      );

      expect(eventOutput).to.include(
        'dhcpcd6.ip_change'
      );
    }
  );
});
