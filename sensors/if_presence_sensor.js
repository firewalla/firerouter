/*    Copyright 2021 Firewalla Inc
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

const Sensor = require('./sensor.js');
const pl = require('../plugins/plugin_loader.js');
const event = require('../core/event.js');
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const fs = require('fs');
const ncm = require('../core/network_config_mgr.js');
const r = require('../util/firerouter.js');
const Message = require('../core/Message.js');
const EventConstants = require('../event/EventConstants.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
let scheduleUpdateWatchersTask = null;

class IfPresenceSensor extends Sensor {

  async run() {
    sclient.on("message", (channel, message) => {
      if (channel === Message.MSG_FR_IFACE_CHANGE_APPLIED) {
        if (scheduleUpdateWatchersTask)
          clearTimeout(scheduleUpdateWatchersTask);
        scheduleUpdateWatchersTask = setTimeout(() => {
          this._updateInterfaceWatchers().catch((err) => {
            this.log.error("Failed to update interface watchers", err.message);
          });
        }, 2000);
      }
    });
    sclient.subscribe(Message.MSG_FR_IFACE_CHANGE_APPLIED);
  }

  async _updateInterfaceWatchers() {
    if (this._watchedFiles) {
      for (const f of this._watchedFiles)
        fs.unwatchFile(f.file, f.listener);
    }
    this.activeIntfs = {};
    const era = require('../event/EventRequestApi');
    this._watchedFiles = [];
    const interfaces = await ncm.getInterfaces();
    for (const intf of Object.keys(interfaces)) {
      const config = interfaces[intf].config;
      if (config.allowHotplug === true && platform.isHotplugSupported(intf)) {
        const listener = (curr, prev) => {
          if (curr.isDirectory() !== prev.isDirectory() || curr.ctimeMs > prev.ctimeMs) {
            const intfPlugin = pl.getPluginInstance("interface", intf);
            if (!intfPlugin)
              return;
            if (curr.ctimeMs > prev.ctimeMs && !this.activeIntfs.hasOwnProperty(intf)) {
              this.activeIntfs[intf] = true;
              const e = event.buildEvent(event.EVENT_IF_PRESENT, {intf: intf});
              era.addStateEvent(EventConstants.EVENT_IF_HOTPLUG_STATE, intf, 0);
              this._sendEvent(e, intfPlugin);
            } else {
              if (!curr.isDirectory() && prev.isDirectory()) {
                delete this.activeIntfs[intf];
                const e = event.buildEvent(event.EVENT_IF_DISAPPEAR, {intf: intf});
                era.addStateEvent(EventConstants.EVENT_IF_HOTPLUG_STATE, intf, 1);
                this._sendEvent(e, intfPlugin);
              }
            }
          }
        }
        this._watchedFiles.push({file: r.getInterfaceSysFSDirectory(intf), listener: listener});
        fs.watchFile(r.getInterfaceSysFSDirectory(intf), {interval: 2000}, listener);
        // initial state event
        const ifExists = await fs.promises.access(r.getInterfaceSysFSDirectory(intf), fs.constants.F_OK).then(() => true).catch((err) => false);
        if (ifExists)
          this.activeIntfs[intf] = true;
        else
          delete this.activeIntfs[intf];
        era.addStateEvent(EventConstants.EVENT_IF_HOTPLUG_STATE, intf, ifExists ? 0 : 1)
      } else {
        if (config.allowHotplug === true)
          this.log.info(`${intf} is not hotplug supported on this platform, skipping`);
      }
    }
  }

  _sendEvent(e, plugin) {
    if (pl.isApplyInProgress()) {
      // defer sending event if plugin_loader is applying another config
      setTimeout(() => {
        this._sendEvent(e, plugin);
      }, 3000);
    } else {
      plugin.propagateEvent(e);
    }
  }
}

module.exports = IfPresenceSensor;