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

// Off-box: the launcher that plugins/dns/dns.template.sh renders into dns.sh. It runs with a fake
// dnsmasq and a fake redis-cli, needs no box and no redis. Each conf file's content picks how the
// fake behaves: "run" stays up, "fail" exits at once.

const chai = require('chai');
const expect = chai.expect;
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEMPLATE = path.resolve(__dirname, '../../plugins/dns/dns.template.sh');

const FAKE_DNSMASQ = `#!/bin/bash
echo "start $$ $*" >> "$FAKE_LOG"
mode=$(<"\${@: -1}")
case $mode in
  fail) exit 3 ;;
  *) exec sleep 1000 ;;
esac
`;

const FAKE_REDIS = `#!/bin/bash
echo "$*" >> "$FAKE_REDIS_LOG"
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error('timed out waiting for condition');
}

describe('dns launcher (dns.template.sh)', function () {
  this.timeout(20000);

  let home, launcher;

  function lines(file) {
    try {
      return fs.readFileSync(path.join(home, file), 'utf8').split('\n').filter(Boolean);
    } catch (err) {
      return [];
    }
  }

  // one entry per dnsmasq start: {pid, args}
  function starts() {
    return lines('dnsmasq.log').map(l => {
      const [, pid, ...args] = l.split(' ');
      return { pid: Number(pid), args: args.join(' ') };
    });
  }

  function writeConf(name, mode) {
    fs.writeFileSync(path.join(home, 'etc', `dnsmasq.dns.${name}.conf`), mode);
  }

  // the launcher gets its own process group, like the unit's cgroup, so the test can always kill it
  function launch(env = {}) {
    const child = cp.spawn('bash', [path.join(home, 'dns.sh')], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        PATH: `${path.join(home, 'bin')}:${process.env.PATH}`,
        FAKE_LOG: path.join(home, 'dnsmasq.log'),
        FAKE_REDIS_LOG: path.join(home, 'redis.log')
      }, env)
    });
    child.out = '';
    child.stdout.on('data', d => { child.out += d; });
    child.stderr.on('data', () => {});
    child.exited = new Promise(resolve => child.on('exit', (code) => resolve(code)));
    launcher = child;
    return child;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-launcher-'));
    for (const d of ['etc', 'bin', 'platform']) fs.mkdirSync(path.join(home, d));
    fs.writeFileSync(path.join(home, 'bin/fake_dnsmasq'), FAKE_DNSMASQ, { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'bin/redis-cli'), FAKE_REDIS, { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'platform/platform.sh'),
      `get_dnsmasq_path() { echo ${home}/bin/fake_dnsmasq; }\n`);
    fs.writeFileSync(path.join(home, 'dns.sh'),
      fs.readFileSync(TEMPLATE, 'utf8').replace(/%FIREROUTER_HOME%/g, home));
  });

  afterEach(() => {
    if (launcher) {
      try { process.kill(-launcher.pid, 'SIGKILL'); } catch (err) { /* already gone */ }
      launcher = null;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('starts one dnsmasq per conf file with the same arguments', async () => {
    writeConf('br0', 'run');
    writeConf('br1', 'run');
    launch();
    await until(() => starts().length === 2);

    const args = starts().map(s => s.args).sort();
    expect(args).to.deep.equal(['br0', 'br1'].map(n =>
      `-k --clear-on-reload -u pi -C ${home}/etc/dnsmasq.dns.${n}.conf`));
  });

  it('bumps the restart counter once per launcher start', async () => {
    writeConf('br0', 'run');
    writeConf('br1', 'run');
    launch();
    await until(() => starts().length === 2);
    await until(() => lines('redis.log').length > 0);

    expect(lines('redis.log')).to.deep.equal(['HINCRBY stats:systemd:restart firerouter_dns 1']);
  });

  it('exits 0 when there is no conf file', async () => {
    const child = launch();

    expect(await child.exited).to.equal(0);
    expect(starts()).to.have.length(0);
  });
});
