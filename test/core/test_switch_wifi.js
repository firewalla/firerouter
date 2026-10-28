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

'use strict'

const path = require('path');
// config.js reads config/config.json from here, resolve it from this checkout so the suite also runs off-device
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

const EventEmitter = require('events');
const expect = require('chai').expect;
const cpp = require('child-process-promise');
const pl = require('../../platform/PlatformLoader.js');
const ns = require('../../core/network_setup.js');
const wpaCliUtil = require('../../util/wpa_cli.js');

const EVENT = (id, reason) => `<3>CTRL-EVENT-SSID-TEMP-DISABLED id=${id} ssid="lab" auth_failures=1 duration=10 reason=${reason}`;

describe('Test switchWifi early failure', function() {
  this.timeout(15000);

  let ncm, calls, monitor, hooks, origGetInterface;

  before(() => {
    // network_config_mgr captures exec, execFile, the platform and the wpa_cli helper at load, so load
    // a private copy with the fakes in place and leave the shared cached copy alone
    const ncmPath = require.resolve('../../core/network_config_mgr.js');
    const cached = require.cache[ncmPath];
    const orig = { exec: cpp.exec, execFile: cpp.execFile, platform: pl.platform, spawn: wpaCliUtil.spawnWpaCliInteractive };

    cpp.exec = async (cmd) => {
      calls.push(`exec: ${cmd}`);
      if (cmd.includes('list_networks'))
        return { stdout: hooks.list, stderr: '' };
      if (cmd.includes(' status'))
        return { stdout: hooks.completed ? 'wpa_state=COMPLETED\n' : 'wpa_state=SCANNING\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    cpp.execFile = async (file, args) => {
      const cmd = [file].concat(args).join(' ');
      calls.push(cmd);
      if (hooks.onCommand)
        hooks.onCommand(cmd);
      if (hooks.failSet && cmd.includes(' set_network '))
        throw new Error('FAIL');
      return { stdout: cmd.endsWith('add_network') ? '1\n' : 'OK\n', stderr: '' };
    };
    pl.platform = {
      getWpaCliBinPath: async () => '/sbin/wpa_cli',
      prepareSwitchWifi: async () => {},
      needResetLinkBeforeSwitchWifi: () => false,
      setDFSScanState: async () => {},
    };
    wpaCliUtil.spawnWpaCliInteractive = (opts) => {
      const child = new EventEmitter();
      calls.push('spawn monitor');
      monitor = { opts, child, writes: [], quits: 0 };
      return {
        child,
        write: (cmd) => {
          monitor.writes.push(cmd);
          if (cmd === 'ping' && hooks.pong)
            setImmediate(() => opts.onLine('> PONG'));
        },
        quit: () => { monitor.quits++; },
      };
    };

    delete require.cache[ncmPath];
    try {
      ncm = require(ncmPath);
    } finally {
      require.cache[ncmPath] = cached;
      cpp.exec = orig.exec;
      cpp.execFile = orig.execFile;
      pl.platform = orig.platform;
      wpaCliUtil.spawnWpaCliInteractive = orig.spawn;
    }

    origGetInterface = ns.getInterface;
    ns.getInterface = async () => ({ config: { enabled: true, meta: { type: 'wan' }, wpaSupplicant: {} } });
  });

  after(() => {
    ns.getInterface = origGetInterface;
  });

  beforeEach(() => {
    calls = [];
    monitor = null;
    hooks = { pong: true, completed: false, onCommand: null, failSet: false, list: '0\tOld\tany\t[CURRENT]\n' };
  });

  const emitLater = (line) => setTimeout(() => monitor.opts.onLine(line), 20);

  it('should fail right after a TEMP-DISABLED event for the selected network and restore', async () => {
    hooks.onCommand = (cmd) => {
      if (cmd.endsWith('select_network 1'))
        emitLater(EVENT(1, 'WRONG_KEY'));
    };
    const start = Date.now();
    const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });

    expect(result).to.eql(['WRONG_KEY']);
    expect(Date.now() - start).to.be.below(2000, 'should not wait for the 3s poll or the 30s timeout');
    expect(monitor.opts.completeLines).to.equal(true);
    expect(monitor.writes).to.eql(['ping']);
    expect(monitor.quits).to.equal(1);
    expect(ncm.isSwitchingWifi()).to.equal(false);

    const wpa = calls.filter(c => c.startsWith('sudo /sbin/wpa_cli')).map(c => c.split(' -i wlan0 ')[1]);
    expect(wpa).to.eql([
      'add_network',
      'disable_network 1',
      'set_network 1 key_mgmt NONE',
      'set_network 1 ssid 6c6162',
      'select_network 1',
      // restore: back to the previous network, re-enable the others
      'reconfigure',
      'select_network 0',
    ]);
  });

  it('should attach the monitor only after the old attempt is stopped', async () => {
    hooks.list = '0\tOld\tany\t[CURRENT]\n1\tlab\tany\t\n';
    hooks.onCommand = (cmd) => {
      if (cmd.endsWith('select_network 1'))
        emitLater(EVENT(1, 'WRONG_KEY'));
    };
    const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(result).to.eql(['WRONG_KEY']);
    // a failure the old attempt raised before the disable never reaches a monitor attached after it
    const disableAt = calls.findIndex(c => c.endsWith('disable_network 1'));
    expect(disableAt).to.be.at.least(0);
    expect(calls.indexOf('spawn monitor')).to.be.above(disableAt);
  });

  it('should ignore events for other networks', async () => {
    hooks.onCommand = (cmd) => {
      if (cmd.endsWith('select_network 1')) {
        emitLater(EVENT(0, 'WRONG_KEY'));
        setTimeout(() => monitor.opts.onLine(EVENT(1, 'AUTH_FAILED')), 60);
      }
    };
    const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(result).to.eql(['AUTH_FAILED']);
    expect(calls.filter(c => c.endsWith('reconfigure'))).to.have.length(1, 'restore runs once');
  });

  it('should restore once and release the lock once when the event races select_network', async () => {
    hooks.onCommand = (cmd) => {
      if (cmd.endsWith('select_network 1')) {
        monitor.opts.onLine(EVENT(1, 'WRONG_KEY'));
        monitor.opts.onLine(EVENT(1, 'WRONG_KEY'));
      }
    };
    const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(result).to.eql(['WRONG_KEY']);
    await new Promise(resolve => setTimeout(resolve, 3500));
    expect(calls.filter(c => c.endsWith('reconfigure'))).to.have.length(1, 'restore runs once');
    expect(calls.filter(c => c.includes(' status'))).to.have.length(1, 'no polling after the early exit');
    expect(ncm.isSwitchingWifi()).to.equal(false);
  });

  it('should fall back to polling when the monitor does not attach', async () => {
    hooks.pong = false;
    hooks.completed = false;
    hooks.onCommand = (cmd) => {
      if (cmd.endsWith('select_network 1'))
        hooks.completed = true;
    };
    const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(result).to.eql([]);
    expect(monitor.quits).to.equal(1);
    expect(calls.some(c => c.endsWith('enable_network 0'))).to.equal(true, 'other networks re-enabled on success');
  });

  it('should keep polling after a transient CONN_FAILED and succeed', async () => {
    hooks.onCommand = (cmd) => {
      if (cmd.endsWith('select_network 1')) {
        emitLater(EVENT(1, 'CONN_FAILED'));
        // wpa_supplicant's own retry gets through
        setTimeout(() => { hooks.completed = true; }, 100);
      }
    };
    const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(result).to.eql([]);
    expect(calls.some(c => c.endsWith('reconfigure'))).to.equal(false, 'no restore on success');
    expect(monitor.quits).to.equal(1);
    expect(ncm.isSwitchingWifi()).to.equal(false);
  });

  it('should return the generic error at the timeout after a non-credential reason', async () => {
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    hooks.onCommand = (cmd) => {
      if (cmd.endsWith('select_network 1'))
        emitLater(EVENT(1, 'CONN_FAILED'));
      // jump past the 30s budget after the first failed poll
      if (cmd.endsWith('bssid_ignore clear'))
        offset = 31000;
    };
    try {
      const start = realNow();
      const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
      expect(result).to.eql(['Failed to switch to lab']);
      expect(realNow() - start).to.be.above(2900, 'CONN_FAILED must not end the switch early');
    } finally {
      Date.now = realNow;
    }
    expect(calls.filter(c => c.endsWith('reconfigure'))).to.have.length(1, 'restore runs once');
    expect(monitor.quits).to.equal(1);
    expect(ncm.isSwitchingWifi()).to.equal(false);
  });

  it('should still fail early on WRONG_KEY after a CONN_FAILED', async () => {
    hooks.onCommand = (cmd) => {
      if (cmd.endsWith('select_network 1')) {
        emitLater(EVENT(1, 'CONN_FAILED'));
        setTimeout(() => monitor.opts.onLine(EVENT(1, 'WRONG_KEY')), 60);
      }
    };
    const start = Date.now();
    const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(result).to.eql(['WRONG_KEY']);
    expect(Date.now() - start).to.be.below(2000);
  });

  it('should quit the monitor when it does not answer the ping', async () => {
    hooks.pong = false;
    let quitsBeforeSelect = null;
    hooks.onCommand = (cmd) => {
      if (cmd.endsWith('select_network 1')) {
        quitsBeforeSelect = monitor.quits;
        hooks.completed = true;
      }
    };
    await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(quitsBeforeSelect).to.equal(1, 'quit right after the ping wait');
    expect(monitor.quits).to.equal(1, 'not quit again at finish');
  });

  const wpaOf = () => calls.filter(c => c.startsWith('sudo /sbin/wpa_cli')).map(c => c.split(' -i wlan0 ')[1]);

  it('should re-enable an enabled target when set_network fails', async () => {
    hooks.list = '0\tOld\tany\t[CURRENT]\n1\tlab\tany\t\n';
    hooks.failSet = true;
    const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(result).to.eql(['FAIL']);
    expect(wpaOf()).to.eql(['disable_network 1', 'set_network 1 key_mgmt NONE', 'enable_network 1']);
    expect(ncm.isSwitchingWifi()).to.equal(false);
  });

  it('should re-enable a TEMP-DISABLED target when set_network fails', async () => {
    hooks.list = '0\tOld\tany\t[CURRENT]\n1\tlab\tany\t[TEMP-DISABLED]\n';
    hooks.failSet = true;
    const result = await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(result).to.eql(['FAIL']);
    expect(wpaOf()).to.eql(['disable_network 1', 'set_network 1 key_mgmt NONE', 'enable_network 1']);
    expect(ncm.isSwitchingWifi()).to.equal(false);
  });

  it('should re-enable an enabled target when a value throws after the disable', async () => {
    hooks.list = '0\tOld\tany\t[CURRENT]\n1\tlab\tany\t\n';
    const result = await ncm.switchWifi('wlan0', 'lab', { psk: 'short' });
    expect(String(result[0])).to.match(/TypeError/);
    expect(wpaOf()).to.eql(['disable_network 1', 'enable_network 1']);
  });

  it('should leave a [DISABLED] target disabled when set_network fails', async () => {
    hooks.list = '0\tOld\tany\t[CURRENT]\n1\tlab\tany\t[DISABLED]\n';
    hooks.failSet = true;
    await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(wpaOf().filter(c => c.startsWith('enable_network'))).to.eql([]);
  });

  it('should not enable a newly added network when set_network fails', async () => {
    hooks.failSet = true;
    await ncm.switchWifi('wlan0', 'lab', { key_mgmt: 'NONE' });
    expect(wpaOf().filter(c => c.startsWith('enable_network'))).to.eql([]);
  });

  it('should reject an unknown key before disabling the target', async () => {
    hooks.list = '0\tOld\tany\t[CURRENT]\n1\tlab\tany\t\n';
    const result = await ncm.switchWifi('wlan0', 'lab', { bogus: 'x' });
    expect(result).to.eql(['Invalid wpa_supplicant parameter: bogus']);
    expect(wpaOf()).to.eql([]);
    expect(monitor).to.equal(null, 'no wpa_cli monitor is spawned for a rejected request');
  });
});
