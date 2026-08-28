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

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firerouter-dhcpcd-'));
    stateDir = path.join(sandboxDir, 'state');
    sudoLog = path.join(sandboxDir, 'sudo.log');
    fs.mkdirSync(stateDir);

    copyHookToSandbox(updateRouteScript, path.join(sandboxDir, 'update_rt'), stateDir);
    fs.writeFileSync(path.join(stateDir, 'dhcpcd.gw6.wan0'), 'fe80::a\n');
  });

  afterEach(() => {
    fs.rmSync(sandboxDir, {recursive: true, force: true});
  });

  it('keeps the cached default route when a different router advertises a zero lifetime', () => {
    const runner = path.join(sandboxDir, 'run-hook');
    fs.writeFileSync(runner, `#!/bin/bash

reason=ROUTERADVERT
interface=wan0
default_rt_tables=main
RECORD_LEASE_GW6=fe80::b
RECORD_LEASE_ND_ID=1
IP_LOG=${path.join(sandboxDir, 'ip.log')}
SUDO_LOG=${sudoLog}

printf 'ra_router_lifetime=0\\n' > ${path.join(stateDir, 'dhcpcd.ra.wan0')}

ip() {
  printf '%s\\n' "$*" >> "$IP_LOG"
  if [ "$1" = "-4" ]; then
    echo "inet 192.0.2.10/24"
  elif [ "$1" = "-6" ] && [ "$2" = "route" ] && [ "$3" = "show" ]; then
    echo "default via fe80::a dev wan0"
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
  printf '%s\\n' "$*" >> "$SUDO_LOG"
  "$@"
}

redis-cli() {
  :
}

source ${commonScript}
source ${path.join(sandboxDir, 'update_rt')}
`);

    execFileSync('bash', [runner], {stdio: 'pipe'});

    expect(fs.readFileSync(path.join(stateDir, 'dhcpcd.gw6.wan0'), 'utf8')).to.equal('fe80::a\n');
    expect(fs.existsSync(sudoLog) ? fs.readFileSync(sudoLog, 'utf8') : '').to.equal('');
  });
});
