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
const commonScript = path.join(
  repoRoot,
  'scripts/firerouter_dhcpcd_common'
);
const recordLeaseScript = path.join(
  repoRoot,
  'scripts/firerouter_dhcpcd_record_lease'
);
const updateRouteScript = path.join(
  repoRoot,
  'scripts/firerouter_dhcpcd_update_rt'
);


function copyHookToSandbox(source, destination, stateDir) {
  const content = fs.readFileSync(source, 'utf8')
    .split('/dev/shm')
    .join(stateDir);

  fs.writeFileSync(
    destination,
    content
  );
}


describe('DHCPv6 Router Advertisement route updates', () => {
  let sandboxDir;
  let stateDir;
  let sudoLog;
  let eventLog;
  let ipLog;
  let queryLog;
  let routeState;
  let queryFailures;
  let deleteFailures;
  let deleteThenDisappear;


  function writeLines(file, lines) {
    fs.writeFileSync(
      file,
      lines.length > 0
        ? `${lines.join('\n')}\n`
        : ''
    );
  }


  function readLines(file) {
    if (!fs.existsSync(file)) {
      return [];
    }

    const content = fs.readFileSync(
      file,
      'utf8'
    ).trim();

    return content
      ? content.split('\n')
      : [];
  }


  function routeKey(table, gateway) {
    return `${table}|${gateway}`;
  }


  function setRoutes(routes) {
    writeLines(
      routeState,
      routes.map(({ table, gateway }) => {
        return routeKey(table, gateway);
      })
    );
  }


  function setQueryFailures(tables) {
    writeLines(
      queryFailures,
      tables
    );
  }


  function setDeleteFailures(routes) {
    writeLines(
      deleteFailures,
      routes.map(({ table, gateway }) => {
        return routeKey(table, gateway);
      })
    );
  }


  function setDeleteThenDisappear(routes) {
    writeLines(
      deleteThenDisappear,
      routes.map(({ table, gateway }) => {
        return routeKey(table, gateway);
      })
    );
  }


  function createRunner({
    gateway,
    lifetime,
    routeTables = ['main'],
    ndRecords = null,
  }) {
    const runner = path.join(
      sandboxDir,
      `run-hook-${gateway.replace(/:/g, '-')}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`
    );

    const records = ndRecords || [{
      id: 1,
      gateway,
      lifetime
    }];

    const ndEnv = records.map(({ id, gateway: ndGateway, lifetime: ndLifetime }) => {
      return [
        `nd${id}_from=${ndGateway || ''}`,
        `nd${id}_lifetime=${ndLifetime === undefined ? '' : ndLifetime}`,
        `nd${id}_mtu=1500`
      ].join('\n');
    }).join('\n');

    fs.writeFileSync(
      runner,
      `#!/bin/bash

reason=ROUTERADVERT
interface=wan0
default_rt_tables="${routeTables.join(' ')}"
rt_tables="${routeTables.join(' ')}"
mtu=1500
metric=1024

${ndEnv}

IP_LOG=${ipLog}
QUERY_LOG=${queryLog}
SUDO_LOG=${sudoLog}
EVENT_LOG=${eventLog}
ROUTE_STATE=${routeState}
QUERY_FAILURES=${queryFailures}
DELETE_FAILURES=${deleteFailures}
DELETE_THEN_DISAPPEAR=${deleteThenDisappear}

ip() {
  printf '%s\\\\n' "$*" >> "$IP_LOG"

  if [ "$1" = "-4" ] &&
     [ "$2" = "addr" ] &&
     [ "$3" = "show" ] &&
     [ "$4" = "dev" ]; then
    echo "inet 10.0.0.2/24"
    return 0
  fi

  if [ "$1" = "-6" ] &&
     [ "$2" = "route" ] &&
     [ "$3" = "show" ]; then

    requested_table=""
    requested_gateway=""

    if [ "$4" = "table" ] &&
       [ "$6" = "default" ] &&
       [ "$7" = "via" ]; then
      requested_table="$5"
      requested_gateway="$8"
    fi

    printf '%s\\\\n' "$requested_table" >> "$QUERY_LOG"

    if grep -F -x "$requested_table" "$QUERY_FAILURES" >/dev/null 2>&1; then
      return 1
    fi

    route_key="${requested_table}|${requested_gateway}"

    if grep -F -x "$route_key" "$ROUTE_STATE" >/dev/null 2>&1; then
      echo "default via ${requested_gateway} dev wan0"
    fi

    return 0
  fi

  if [ "$1" = "-6" ] &&
     [ "$2" = "r" ] &&
     [ "$3" = "del" ]; then

    requested_table=""
    requested_gateway=""

    if [ "$4" = "default" ] &&
       [ "$5" = "via" ] &&
       [ "$7" = "table" ]; then
      requested_gateway="$6"
      requested_table="$8"
    fi

    route_key="${requested_table}|${requested_gateway}"

    if grep -F -x "$route_key" "$DELETE_FAILURES" >/dev/null 2>&1; then
      if grep -F -x "$route_key" "$DELETE_THEN_DISAPPEAR" >/dev/null 2>&1; then
        tmp_state="\${ROUTE_STATE}.tmp"

        grep -F -x -v "$route_key" "$ROUTE_STATE" > "$tmp_state" || true
        mv "$tmp_state" "$ROUTE_STATE"
      fi

      return 1
    fi

    tmp_state="\${ROUTE_STATE}.tmp"

    grep -F -x -v "$route_key" "$ROUTE_STATE" > "$tmp_state" || true
    mv "$tmp_state" "$ROUTE_STATE"

    return 0
  fi

  return 0
}

sudo() {
  printf '%s\\\\n' "$*" >> "$SUDO_LOG"
  "\\$@"
}

redis-cli() {
  printf '%s\\\\n' "$*" >> "$EVENT_LOG"
}

source ${commonScript}

log() {
  printf '%s\\\\n' "$*" >> "$EVENT_LOG"
}

# Execute the hooks in the same order as dhcpcd-run-hooks:
# common -> record_lease -> update_rt.
source ${path.join(sandboxDir, 'record_lease')}
source ${path.join(sandboxDir, 'update_rt')}
`
    );

    fs.chmodSync(
      runner,
      0o755
    );

    return runner;
  }


  function runHook(options) {
    const runner = createRunner(options);

    execFileSync(
      'bash',
      [runner],
      {
        stdio: 'pipe'
      }
    );
  }


  function getCache() {
    const cache = path.join(
      stateDir,
      'dhcpcd.gw6.wan0'
    );

    if (!fs.existsSync(cache)) {
      return null;
    }

    return fs.readFileSync(
      cache,
      'utf8'
    );
  }


  function getRAFile() {
    return fs.readFileSync(
      path.join(
        stateDir,
        'dhcpcd.ra.wan0'
      ),
      'utf8'
    );
  }


  function getSudoOutput() {
    return fs.readFileSync(
      sudoLog,
      'utf8'
    );
  }


  function getEventOutput() {
    return fs.readFileSync(
      eventLog,
      'utf8'
    );
  }


  function getIpOutput() {
    return fs.readFileSync(
      ipLog,
      'utf8'
    );
  }


  function getQueryOutput() {
    return readLines(
      queryLog
    );
  }


  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        'firerouter-dhcpcd-'
      )
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

    queryLog = path.join(
      sandboxDir,
      'query.log'
    );

    routeState = path.join(
      sandboxDir,
      'routes.state'
    );

    queryFailures = path.join(
      sandboxDir,
      'query.failures'
    );

    deleteFailures = path.join(
      sandboxDir,
      'delete.failures'
    );

    deleteThenDisappear = path.join(
      sandboxDir,
      'delete.then.disappear'
    );

    fs.mkdirSync(
      stateDir
    );

    copyHookToSandbox(
      recordLeaseScript,
      path.join(
        sandboxDir,
        'record_lease'
      ),
      stateDir
    );

    copyHookToSandbox(
      updateRouteScript,
      path.join(
        sandboxDir,
        'update_rt'
      ),
      stateDir
    );

    fs.writeFileSync(
      path.join(
        stateDir,
        'dhcpcd.gw6.wan0'
      ),
      'fe80::a\n'
    );

    writeLines(
      routeState,
      []
    );

    writeLines(
      queryFailures,
      []
    );

    writeLines(
      deleteFailures,
      []
    );

    writeLines(
      deleteThenDisappear,
      []
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

    fs.writeFileSync(
      queryLog,
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
    'uses the Router Lifetime from the selected Router Advertisement',
    () => {
      runHook({
        gateway: 'fe80::b',
        lifetime: '1800',
        ndRecords: [
          {
            id: 1,
            gateway: 'fe80::a',
            lifetime: '0'
          },
          {
            id: 2,
            gateway: 'fe80::b',
            lifetime: '1800'
          }
        ]
      });

      const raFile = getRAFile();

      expect(raFile).to.include(
        'gw6=fe80::b'
      );

      expect(raFile).to.include(
        'ra_router_lifetime=1800'
      );

      expect(getSudoOutput()).to.include(
        'ip -6 r replace default via fe80::b dev wan0 mtu 1500 table main'
      );

      expect(getCache()).to.equal(
        'fe80::b\n'
      );
    }
  );


  it(
    'does not withdraw router A when different router B advertises a zero lifetime',
    () => {
      setRoutes([
        {
          table: 'main',
          gateway: 'fe80::a'
        }
      ]);

      runHook({
        gateway: 'fe80::b',
        lifetime: '0'
      });

      const sudoOutput = getSudoOutput();
      const eventOutput = getEventOutput();
      const ipOutput = getIpOutput();

      expect(eventOutput).to.include(
        'ROUTERADVERT: router lifetime is 0 for non-managed router fe80::b'
      );

      expect(getCache()).to.equal(
        'fe80::a\n'
      );

      expect(sudoOutput).to.not.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      expect(sudoOutput).to.not.include(
        'ip -6 r del default via fe80::b dev wan0 table main'
      );

      expect(ipOutput).to.not.include(
        '-6 route show'
      );

      expect(eventOutput).to.not.include(
        'dhcpcd6.ip_change'
      );
    }
  );


  it(
    'withdraws the currently cached router when that router advertises a zero lifetime',
    () => {
      setRoutes([
        {
          table: 'main',
          gateway: 'fe80::a'
        }
      ]);

      runHook({
        gateway: 'fe80::a',
        lifetime: '0'
      });

      const sudoOutput = getSudoOutput();
      const eventOutput = getEventOutput();
      const ipOutput = getIpOutput();
      const queryOutput = getQueryOutput();

      expect(getCache()).to.equal(
        null
      );

      expect(ipOutput).to.include(
        '-6 route show table main default via fe80::a dev wan0'
      );

      expect(queryOutput).to.deep.equal([
        'main'
      ]);

      expect(sudoOutput).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      expect(eventOutput).to.include(
        'ip_changed: IPv6 default route state changed on wan0'
      );

      expect(eventOutput).to.include(
        'dhcpcd6.ip_change'
      );
    }
  );


  it(
    'installs a default route when the router lifetime is nonzero',
    () => {
      runHook({
        gateway: 'fe80::b',
        lifetime: '1800'
      });

      const sudoOutput = getSudoOutput();
      const eventOutput = getEventOutput();

      expect(sudoOutput).to.include(
        'ip -6 r replace default via fe80::b dev wan0 mtu 1500 table main'
      );

      expect(getCache()).to.equal(
        'fe80::b\n'
      );

      expect(eventOutput).to.include(
        'ip_changed: gw6 changed from fe80::a to fe80::b on wan0'
      );

      expect(eventOutput).to.include(
        'dhcpcd6.ip_change'
      );
    }
  );


  it(
    'removes managed routes from every configured routing table',
    () => {
      setRoutes([
        {
          table: 'main',
          gateway: 'fe80::a'
        },
        {
          table: '100',
          gateway: 'fe80::a'
        },
        {
          table: '200',
          gateway: 'fe80::a'
        }
      ]);

      runHook({
        gateway: 'fe80::a',
        lifetime: '0',
        routeTables: [
          'main',
          '100',
          '200'
        ]
      });

      const sudoOutput = getSudoOutput();

      expect(sudoOutput).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      expect(sudoOutput).to.include(
        'ip -6 r del default via fe80::a dev wan0 table 100'
      );

      expect(sudoOutput).to.include(
        'ip -6 r del default via fe80::a dev wan0 table 200'
      );

      expect(readLines(routeState)).to.deep.equal(
        []
      );

      expect(getCache()).to.equal(
        null
      );
    }
  );


  it(
    'treats an already-absent route as successful cleanup',
    () => {
      setRoutes([
        {
          table: 'main',
          gateway: 'fe80::a'
        }
      ]);

      runHook({
        gateway: 'fe80::a',
        lifetime: '0',
        routeTables: [
          'main',
          '100'
        ]
      });

      const sudoOutput = getSudoOutput();
      const queryOutput = getQueryOutput();

      expect(sudoOutput).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      expect(sudoOutput).to.not.include(
        'ip -6 r del default via fe80::a dev wan0 table 100'
      );

      expect(queryOutput).to.deep.equal([
        'main',
        '100'
      ]);

      expect(readLines(routeState)).to.deep.equal(
        []
      );

      expect(getCache()).to.equal(
        null
      );

      expect(getEventOutput()).to.include(
        'dhcpcd6.ip_change'
      );
    }
  );


  it(
    'retains the cached gateway when route-query fails and retries successfully later',
    () => {
      setRoutes([
        {
          table: 'main',
          gateway: 'fe80::a'
        },
        {
          table: '100',
          gateway: 'fe80::a'
        }
      ]);

      setQueryFailures([
        '100'
      ]);

      runHook({
        gateway: 'fe80::a',
        lifetime: '0',
        routeTables: [
          'main',
          '100'
        ]
      });

      expect(getCache()).to.equal(
        'fe80::a\n'
      );

      expect(readLines(routeState)).to.deep.equal([
        '100|fe80::a'
      ]);

      expect(getSudoOutput()).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      expect(getQueryOutput()).to.deep.equal([
        'main',
        '100'
      ]);

      expect(getEventOutput()).to.include(
        'failed to query IPv6 default route via fe80::a from table 100'
      );

      expect(getEventOutput()).to.include(
        'retaining cached IPv6 gateway fe80::a because cleanup is incomplete'
      );

      setQueryFailures([]);

      runHook({
        gateway: 'fe80::a',
        lifetime: '0',
        routeTables: [
          'main',
          '100'
        ]
      });

      expect(readLines(routeState)).to.deep.equal(
        []
      );

      expect(getCache()).to.equal(
        null
      );

      expect(getSudoOutput()).to.include(
        'ip -6 r del default via fe80::a dev wan0 table 100'
      );
    }
  );


  it(
    'retains the cached gateway when route deletion fails and verifies that the route still exists before retrying later',
    () => {
      setRoutes([
        {
          table: 'main',
          gateway: 'fe80::a'
        }
      ]);

      setDeleteFailures([
        {
          table: 'main',
          gateway: 'fe80::a'
        }
      ]);

      runHook({
        gateway: 'fe80::a',
        lifetime: '0'
      });

      expect(getCache()).to.equal(
        'fe80::a\n'
      );

      expect(readLines(routeState)).to.deep.equal([
        'main|fe80::a'
      ]);

      expect(getSudoOutput()).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      /*
       * The production code must perform:
       *
       *   1. initial route query
       *   2. failed route deletion
       *   3. post-delete verification query
       *
       * Seeing two queries proves the failure path was actually exercised.
       */
      expect(getQueryOutput()).to.deep.equal([
        'main',
        'main'
      ]);

      expect(getEventOutput()).to.include(
        'failed to remove IPv6 default route via fe80::a from table main'
      );

      expect(getEventOutput()).to.include(
        'retaining cached IPv6 gateway fe80::a because cleanup is incomplete'
      );
    }
  );


  it(
    'treats a failed deletion followed by a route disappearing as successful cleanup',
    () => {
      setRoutes([
        {
          table: 'main',
          gateway: 'fe80::a'
        }
      ]);

      setDeleteFailures([
        {
          table: 'main',
          gateway: 'fe80::a'
        }
      ]);

      setDeleteThenDisappear([
        {
          table: 'main',
          gateway: 'fe80::a'
        }
      ]);
      
      fs.writeFileSync(
        path.join(
          stateDir,
          'dhcpcd.ip6.wan0'
        ),
        ',\n'
      );

      runHook({
        gateway: 'fe80::a',
        lifetime: '0'
      });

      expect(readLines(routeState)).to.deep.equal(
        []
      );

      expect(getCache()).to.equal(
        null
      );

      /*
       * The delete returned failure, so the helper must verify the route
       * state instead of assuming that the deletion succeeded or failed.
       */
      expect(getQueryOutput()).to.deep.equal([
        'main',
        'main'
      ]);

      expect(getSudoOutput()).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      expect(getEventOutput()).to.include(
        'IPv6 default route via fe80::a from table main was already absent after delete attempt'
      );

      expect(getEventOutput()).to.include(
        'ip_changed: IPv6 default route state changed on wan0'
      );

      expect(getEventOutput()).to.include(
        'dhcpcd6.ip_change'
      );
    }
  );


  it(
    'supports partial cleanup followed by a successful retry',
    () => {
      setRoutes([
        {
          table: 'main',
          gateway: 'fe80::a'
        },
        {
          table: '100',
          gateway: 'fe80::a'
        }
      ]);

      setDeleteFailures([
        {
          table: '100',
          gateway: 'fe80::a'
        }
      ]);

      runHook({
        gateway: 'fe80::a',
        lifetime: '0',
        routeTables: [
          'main',
          '100'
        ]
      });

      expect(readLines(routeState)).to.deep.equal([
        '100|fe80::a'
      ]);

      expect(getCache()).to.equal(
        'fe80::a\n'
      );

      expect(getSudoOutput()).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      expect(getSudoOutput()).to.include(
        'ip -6 r del default via fe80::a dev wan0 table 100'
      );

      /*
       * main is queried once and table 100 is queried twice:
       *
       *   main -> exists -> delete succeeds
       *   100  -> exists -> delete fails -> verify still exists
       */
      expect(getQueryOutput()).to.deep.equal([
        'main',
        '100',
        '100'
      ]);

      setDeleteFailures([]);

      runHook({
        gateway: 'fe80::a',
        lifetime: '0',
        routeTables: [
          'main',
          '100'
        ]
      });

      expect(readLines(routeState)).to.deep.equal(
        []
      );

      expect(getCache()).to.equal(
        null
      );

      expect(getQueryOutput()).to.deep.equal([
        'main',
        '100',
        '100',
        '100'
      ]);
    }
  );


  it(
    'preserves legacy behavior when ra_router_lifetime is missing',
    () => {
      runHook({
        gateway: 'fe80::b'
      });

      const raFile = getRAFile();

      expect(raFile).to.include(
        'ra_router_lifetime='
      );

      expect(getSudoOutput()).to.include(
        'ip -6 r replace default via fe80::b dev wan0 mtu 1500 table main'
      );

      expect(getCache()).to.equal(
        'fe80::b\n'
      );

      expect(getIpOutput()).to.not.include(
        '-6 route show table main default via'
      );

      expect(getQueryOutput()).to.deep.equal(
        []
      );
    }
  );


  it(
    'treats malformed persisted Router Lifetime values as unavailable',
    () => {
      const malformedValues = [
        'abc',
        '-1',
        '+60',
        '1.5',
        '60 seconds',
      ];

      for (const lifetime of malformedValues) {
        fs.writeFileSync(
          routeState,
          ''
        );

        fs.writeFileSync(
          path.join(
            stateDir,
            'dhcpcd.gw6.wan0'
          ),
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

        fs.writeFileSync(
          queryLog,
          ''
        );

        runHook({
          gateway: 'fe80::b',
          lifetime
        });

        expect(getSudoOutput()).to.include(
          'ip -6 r replace default via fe80::b dev wan0 mtu 1500 table main'
        );

        expect(getCache()).to.equal(
          'fe80::b\n'
        );

        expect(getQueryOutput()).to.deep.equal(
          []
        );
      }
    }
  );


  it(
    'accepts a zero lifetime represented with leading zeroes',
    () => {
      setRoutes([
        {
          table: 'main',
          gateway: 'fe80::a'
        }
      ]);

      runHook({
        gateway: 'fe80::a',
        lifetime: '000'
      });

      const raFile = getRAFile();

      expect(raFile).to.include(
        'ra_router_lifetime=000'
      );

      expect(readLines(routeState)).to.deep.equal(
        []
      );

      expect(getCache()).to.equal(
        null
      );

      expect(getSudoOutput()).to.include(
        'ip -6 r del default via fe80::a dev wan0 table main'
      );

      expect(getQueryOutput()).to.deep.equal([
        'main'
      ]);
    }
  );
});
