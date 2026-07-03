/*    Copyright 2019 Firewalla Inc
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

const InterfaceBasePlugin = require('./intf_base_plugin.js');
const exec = require('child-process-promise').exec;
const { spawn } = require('child_process');
const pl = require('../plugin_loader.js');
const fsp = require('fs').promises;
const _ = require('lodash');

class BridgeInterfacePlugin extends InterfaceBasePlugin {

  isFlushNeeded(newConfig) {
    // flush is needed if attributes other than stp are changed
    const c1 = _.pick(this.networkConfig, Object.keys(this.networkConfig).filter(k => k !== "stp"));
    const c2 = _.pick(newConfig, Object.keys(newConfig).filter(k => k !== "stp"));
    return !_.isEqual(c1, c2);
  }

  async flush() {
    if (this._stateSync) {
      await this._stateSync.stopMonitor();
      const isVlanBridge = this.networkConfig.intf.every(i => i.includes('.'));
      if (!isVlanBridge) {
        for (const physicalIntf of this.networkConfig.intf)
          await BridgePortStateSync.applyVlanPortStates(physicalIntf, 3, this.log).catch(() => {});
      }
    }
    await super.flush();
    if (this.networkConfig && this.networkConfig.enabled) {
      await exec(`sudo ip link set dev ${this.name} down`).catch((err) => {});
      await exec(`sudo brctl stp ${this.name} off`).catch((err) => {});
      await exec(`sudo brctl delbr ${this.name}`).catch((err) => {});
    }
  }

  async createInterface() {
    const presentInterfaces = [];
    for (const intf of this.networkConfig.intf) {
      await exec(`sudo ip addr flush dev ${intf}`).catch((err) => {});
      const intfPlugin = pl.getPluginInstance("interface", intf);
      if (intfPlugin) {
        // this is useful if it is a passthrough bridge
        this.subscribeChangeFrom(intfPlugin);
        if (await intfPlugin.isInterfacePresent() === false) {
          this.log.warn(`Interface ${intf} is not present yet`);
          continue;
        }
        presentInterfaces.push(intf);
      } else {
        this.fatal(`Lower interface plugin not found ${intf}`);
      }
    }

    await exec(`sudo brctl addbr ${this.name}`).catch((err) => {
      this.log.debug(`Failed to create bridge interface ${this.name}`, err.message);
    });

    const isVlanBridge = this.networkConfig.intf.every(i => i.includes('.'));
    if (this.networkConfig.intf.length > 1 && !isVlanBridge) {
      // start mstpd if not already running; no-op if already active
      await exec(`sudo systemctl start firerouter_mstpd`).catch((err) => {
        this.log.warn(`Failed to start mstpd service`, err.message);
      });
      if (this.networkConfig.stp !== false) {
        // a bridge left at stp_state=1 (kernel STP) by a previous firerouter version would silently stay at 1 
        // instead of transitioning to stp_state=2 (BR_USER_STP).
        await exec(`sudo brctl stp ${this.name} off`).catch((err) => {});
        // brctl stp on causes the kernel to invoke /sbin/bridge-stp, which calls mstpctl addbridge
        // and returns exit 0, so the kernel automatically sets stp_state=2 (BR_USER_STP).
        await exec(`sudo brctl stp ${this.name} on`).catch((err) => {
          this.log.error(`Failed to enable STP on ${this.name}`, err.message);
        });
        if (!this._stateSync)
          this._stateSync = new BridgePortStateSync(this.name, this.log);
        await this._stateSync.startMonitor(this.networkConfig.intf);
      } else {
        // brctl stp off invokes /sbin/bridge-stp stop → mstpctl delbridge, stp_state=0
        await exec(`sudo brctl stp ${this.name} off`).catch((err) => {});
        if (this._stateSync)
          await this._stateSync.stopMonitor();
        // STP is no longer controlling port states; reset VLAN ports to forwarding
        for (const physicalIntf of this.networkConfig.intf)
          await BridgePortStateSync.applyVlanPortStates(physicalIntf, 3, this.log).catch(() => {});
      }
    } else {
      // VLAN bridges should always have STP disabled; clear any stale kernel STP state
      await exec(`sudo brctl stp ${this.name} off`).catch((err) => {});
    }

    const existingIntf = await fsp.readdir(`/sys/class/net/${this.name}/brif`);
    for (const intf of existingIntf) {
      if (!presentInterfaces.includes(intf)) {
        await exec(`sudo brctl delif ${this.name} ${intf}`).catch((err) => {
          this.log.error(`Failed to remove interface ${intf} from bridge ${this.name}`, err.message);
        });
      }
    }

    if (presentInterfaces.length > 0)
      // add interfaces one at a time. Otherwise, if one interface cannot be added to bridge, the interfaces behind it will be skipped
      for (const iface of presentInterfaces) {
        if (existingIntf.includes(iface))
          continue;
        await exec(`sudo brctl addif ${this.name} ${iface}`).catch((err) => {
          this.log.error(`Failed to add interface ${iface} to bridge ${this.name}`, err.message);
        })
      }

    if (isVlanBridge) {
      if (!this._stateSync)
        this._stateSync = new BridgePortStateSync(this.name, this.log);
      await this._stateSync.syncInitialPortStates(this.networkConfig.intf);
    }

    return true;
  }

  getDefaultMTU() {
    return 1500;
  }

  async getSubIntfs() {
    // return runtime lower interfaces from sysfs brif directory, the effective config may be different from the frcc config due to integrated AP config
    const brifs = await fsp.readdir(`/sys/class/net/${this.name}/brif`).catch((err) => {
      this.log.error(`Failed to read brif of bridge ${this.name}`, err.message);
      return null;
    });
    return brifs;
  }

  isEthernetBasedInterface() {
    return true;
  }

  static async preparePlugin() {
    await super.preparePlugin();
    const r = require('../../util/firerouter.js');
    await exec(`sudo cp -f ${r.getFireRouterHome()}/scripts/firerouter_mstpd.service /etc/systemd/system/`);
    await exec(`sudo install -m 755 ${r.getFireRouterHome()}/scripts/bridge-stp.sh /sbin/bridge-stp`);
  }
}

module.exports = BridgeInterfacePlugin;

class BridgePortStateSync {
  // upper bound on how long startMonitor() waits for the initial per-interface sync to land
  static INITIAL_SYNC_TIMEOUT_MS = 3000;

  constructor(bridgeName, log) {
    this._bridgeName = bridgeName;
    this._log = log;
    this._monitorProcess = null;
    this._pendingStates = new Map();
    this._runningIntfs = new Set();
    this._runLoopPromises = new Map();
  }

  // Kill the bridge monitor link subprocess and wait for any in-flight apply to finish, so that
  // once this resolves, the caller's own state changes are guaranteed to land last.
  async stopMonitor() {
    if (this._monitorProcess) {
      this._monitorProcess.kill();
      this._monitorProcess = null;
    }
    this._pendingStates.clear();
    await Promise.all(this._runLoopPromises.values());
  }

  // Watch `bridge monitor link` for port state changes, then sync current native bridge port states to VLAN ports.
  async startMonitor(memberIntfs) {
    await this.stopMonitor();
    const proc = spawn('bridge', ['monitor', 'link'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this._monitorProcess = proc;
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      if (this._monitorProcess !== proc) return;
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) this._handleLine(line);
    });
    proc.on('exit', (code, signal) => {
      if (this._monitorProcess === proc) {
        this._log.warn(`bridge monitor link exited (code=${code} signal=${signal}); port state sync paused until next apply`);
        this._monitorProcess = null;
      }
    });
    proc.on('error', (err) => {
      this._log.warn(`bridge monitor link error`, err.message);
    });
    for (const physicalIntf of memberIntfs) {
      const raw = await fsp.readFile(`/sys/class/net/${this._bridgeName}/brif/${physicalIntf}/state`, 'utf8').catch(() => null);
      if (raw !== null)
        this._scheduleApply(physicalIntf, parseInt(raw.trim(), 10));
    }
    // bounded wait: the monitor is already live at this point, so a physical interface that keeps
    // flapping would keep its _runLoop (and this wait) alive indefinitely otherwise
    const settled = await Promise.race([
      Promise.all(this._runLoopPromises.values()).then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), BridgePortStateSync.INITIAL_SYNC_TIMEOUT_MS))
    ]);
    if (!settled)
      this._log.warn(`startMonitor: initial VLAN port state sync did not settle within ${BridgePortStateSync.INITIAL_SYNC_TIMEOUT_MS}ms, possibly due to flapping; continuing`);
  }

  // Set each VLAN sub-interface's bridge port state to match its physical interface's current native bridge state.
  async syncInitialPortStates(vlanIntfs) {
    for (const vlanIntf of vlanIntfs) {
      const physicalIntf = await BridgePortStateSync.getPhysicalIntf(vlanIntf);
      if (!physicalIntf) continue;
      const state = await BridgePortStateSync.getNativeBridgePortState(physicalIntf);
      if (state === undefined) continue;
      const targetState = (state === null || state === 3) ? 'forwarding' : 'disabled';
      await exec(`sudo bridge link set dev ${vlanIntf} state ${targetState}`)
        .catch(err => this._log.debug(`syncInitialPortStates: bridge link set failed for ${vlanIntf}`, err.message));
    }
  }

  _handleLine(line) {
    const masterMatch = line.match(/master\s+(\S+)/);
    if (!masterMatch || masterMatch[1] !== this._bridgeName) return;
    const intfMatch = line.match(/^\s*\d+:\s+(\S+?)(?:@\S+)?:/);
    if (!intfMatch) return;
    const physicalIntf = intfMatch[1];
    const stateMatch = line.match(/\bstate\s+(\w+)/);
    if (!stateMatch) return;
    const stateMap = { forwarding: 3, blocking: 4, disabled: 0, listening: 1, learning: 2 };
    const stateNum = stateMap[stateMatch[1]];
    if (stateNum === undefined) return;
    this._scheduleApply(physicalIntf, stateNum);
  }

  _scheduleApply(physicalIntf, stateNum) {
    this._pendingStates.set(physicalIntf, stateNum);
    if (this._runningIntfs.has(physicalIntf)) return;
    const p = this._runLoop(physicalIntf).finally(() => this._runLoopPromises.delete(physicalIntf));
    this._runLoopPromises.set(physicalIntf, p);
  }

  async _runLoop(physicalIntf) {
    this._runningIntfs.add(physicalIntf);
    try {
      while (this._pendingStates.has(physicalIntf)) {
        const stateNum = this._pendingStates.get(physicalIntf);
        this._pendingStates.delete(physicalIntf);
        await BridgePortStateSync.applyVlanPortStates(physicalIntf, stateNum, this._log)
          .catch(err => this._log && this._log.warn(`applyVlanPortStates failed for ${physicalIntf}`, err.message));
      }
    } finally {
      this._runningIntfs.delete(physicalIntf);
    }
  }

  static async getPhysicalIntf(vlanIntf) {
    if (!vlanIntf.includes('.')) return null;
    const entries = await fsp.readdir(`/sys/class/net/${vlanIntf}/`).catch(() => null);
    if (!entries) return null;
    const lowerEntry = entries.find(e => e.startsWith('lower_'));
    return lowerEntry ? lowerEntry.slice('lower_'.length) : null;
  }

  // Returns the STP port state number, null if physicalIntf has no native bridge master,
  // or undefined if the state file exists but could not be read (caller should skip).
  static async getNativeBridgePortState(physicalIntf) {
    const nativeBridge = await fsp.readlink(`/sys/class/net/${physicalIntf}/master`)
      .then(p => p.split('/').pop())
      .catch(() => null);
    if (!nativeBridge) return null;
    const raw = await fsp.readFile(`/sys/class/net/${nativeBridge}/brif/${physicalIntf}/state`, 'utf8').catch(() => undefined);
    if (raw === undefined) return undefined;
    return parseInt(raw.trim(), 10);
  }

  // Set all VLAN sub-interfaces of physicalIntf to forwarding (stpState===3) or disabled.
  // All non-forwarding states (blocking, listening, learning, disabled) collapse to disabled:
  // the VLAN bridge has STP off, so only forwarding/disabled have defined kernel semantics there.
  static async applyVlanPortStates(physicalIntf, stpState, log) {
    const targetState = stpState === 3 ? 'forwarding' : 'disabled';
    const allIntfs = await fsp.readdir('/sys/class/net/').catch(() => []);
    const vlanIntfs = allIntfs.filter(i => i.startsWith(`${physicalIntf}.`));
    for (const vlanIntf of vlanIntfs) {
      await exec(`sudo bridge link set dev ${vlanIntf} state ${targetState}`)
        .catch(err => { if (log) log.warn(`applyVlanPortStates: bridge link set dev ${vlanIntf} state ${targetState} failed`, err.message); });
    }
  }
}
