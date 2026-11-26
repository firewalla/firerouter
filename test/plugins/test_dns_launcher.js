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
// fake behaves: "run" stays up, "fail" exits at once, "die1" runs for one second and exits.
//
// bash's $SECONDS has a one second resolution, so no case sits on a MIN_UP_SECS boundary: the
// constants are overridden by env (the unit sets none) to keep a second of margin on both sides.

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
  die1) sleep 1; exit 2 ;;
  *) exec -a "fake_dnsmasq $*" sleep 1000 ;;
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

  function startsOf(name) {
    return starts().filter(s => s.args.endsWith(`dnsmasq.dns.${name}.conf`));
  }

  // the launcher's own log lines
  function logLines() {
    return launcher.out.split('\n').filter(l => l.startsWith('dns_launcher: '));
  }

  // live fake dnsmasq pids in the launcher's group, matched the way ExecReload's pkill matches
  function reloadTargets() {
    const r = cp.spawnSync('pgrep', ['-g', String(launcher.pid), '-f', 'dnsmasq\\.dns']);
    return r.stdout.toString().split('\n').filter(Boolean).map(Number).sort();
  }

  function groupGone() {
    return cp.spawnSync('pgrep', ['-g', String(launcher.pid)]).status === 1;
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

  it('keeps healthy instances running while a failing one backs off 1, 2, 4 s', async () => {
    writeConf('br0', 'run');
    writeConf('nosuchif', 'fail');
    const child = launch();
    await until(() => logLines().length >= 3);
    await until(() => lines('redis.log').length > 0);

    expect(logLines().map(l => l.replace(/ up=\ds/, ''))).to.deep.equal([
      'dns_launcher: dnsmasq.dns.nosuchif.conf exited rc=3 retry in 1s',
      'dns_launcher: dnsmasq.dns.nosuchif.conf exited rc=3 retry in 2s',
      'dns_launcher: dnsmasq.dns.nosuchif.conf exited rc=3 retry in 4s'
    ]);
    expect(startsOf('br0')).to.have.length(1);
    expect(startsOf('nosuchif').length).to.be.at.least(3);
    expect(child.exitCode).to.equal(null);
    expect(lines('redis.log')).to.have.length(1);
  });

  it('restarts a killed instance at once and leaves the others alone', async function () {
    writeConf('br0', 'run');
    writeConf('br1', 'run');
    launch({ MIN_UP_SECS: '1' });
    await until(() => starts().length === 2);
    await sleep(2200);

    const before = startsOf('br1')[0].pid;
    process.kill(before, 'SIGKILL');
    await until(() => startsOf('br1').length === 2, 700);

    expect(startsOf('br1')[1].pid).to.not.equal(before);
    expect(startsOf('br0')).to.have.length(1);
    expect(logLines()).to.have.length(1);
    expect(logLines()[0]).to.match(/dnsmasq\.dns\.br1\.conf exited rc=137 up=\ds retry in 0s$/);
    expect(lines('redis.log')).to.have.length(1);
  });

  it('backs off an instance that dies shortly after it started', async () => {
    writeConf('br0', 'die1');
    launch();
    await until(() => logLines().length >= 1);
    const first = Date.now();
    await until(() => startsOf('br0').length === 2);

    expect(logLines()[0]).to.match(/exited rc=2 up=[12]s retry in 1s$/);
    expect(Date.now() - first).to.be.at.least(800);
  });

  it('logs the exit that first brings the delay to MAX_DELAY, then stops', async () => {
    writeConf('nosuchif', 'fail');
    launch({ MAX_DELAY: '2', LOG_EVERY: '600' });
    await until(() => startsOf('nosuchif').length === 3);
    await sleep(1000);

    expect(logLines().map(l => l.replace(/ up=\ds/, ''))).to.deep.equal([
      'dns_launcher: dnsmasq.dns.nosuchif.conf exited rc=3 retry in 1s',
      'dns_launcher: dnsmasq.dns.nosuchif.conf exited rc=3 retry in 2s'
    ]);
  });

  it('logs at most one line per LOG_EVERY once the delay is at its cap', async () => {
    writeConf('nosuchif', 'fail');
    launch({ MAX_DELAY: '1', LOG_EVERY: '3' });
    await sleep(4500);

    expect(startsOf('nosuchif').length).to.be.at.least(4);
    expect(logLines()).to.have.length(2);
  });

  it('only matches the dnsmasq processes when reloading', async () => {
    writeConf('br0', 'run');
    writeConf('br1', 'run');
    writeConf('nosuchif', 'fail');
    launch();
    await until(() => startsOf('br0').length && startsOf('br1').length && startsOf('nosuchif').length);

    expect(reloadTargets()).to.deep.equal([startsOf('br0')[0].pid, startsOf('br1')[0].pid].sort());
  });

  it('leaves no process behind when the group is terminated', async () => {
    writeConf('br0', 'run');
    writeConf('nosuchif', 'fail');
    const child = launch();
    await until(() => startsOf('br0').length && startsOf('nosuchif').length);
    await until(() => logLines().length >= 1);

    // systemd repeats its kill until the cgroup is empty
    const end = Date.now() + 3000;
    while (!groupGone() && Date.now() < end) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (err) { /* already gone */ }
      await sleep(100);
    }

    expect(groupGone()).to.equal(true);
    for (const { pid } of starts()) {
      expect(() => process.kill(pid, 0)).to.throw(/ESRCH/);
    }
  });

  it('exits 0 when there is no conf file', async () => {
    const child = launch();

    expect(await child.exited).to.equal(0);
    expect(starts()).to.have.length(0);
  });
});
