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

const log = require('../util/logger.js')(__filename);

class Plugin {
  constructor(name) {
    this.name = name;
    this.changeSubscribers = [];
    this.changePublishers = []
    this.log = require('../util/logger.js')(this.constructor.name);
    return this;
  }

  init(pluginConfig) {
    this.pluginConfig = pluginConfig;
    this.log.info(`Initializing Plugin ${this.constructor.name}...`);
  }

  configure(networkConfig) {
    this.networkConfig = networkConfig;
  }

  async flush() {
  }

  async apply() {
  }

  async status() {
    return false;
  }

  async state() {
    return null;
  }

  _publishChangeTo(pluginInstance) {
    if (pluginInstance) {
      if (!this.changeSubscribers.includes(pluginInstance)) {
        this.changeSubscribers.push(pluginInstance);
      }
    }
  }

  _unpublishChangeTo(pluginInstance) {
    if (pluginInstance) {
      const index = this.changeSubscribers.indexOf(pluginInstance);
      if (index !== -1) {
        this.changeSubscribers.splice(index, 1);
      }
    }
  }

  subscribeChangeFrom(pluginInstance) {
    if (pluginInstance) {
      pluginInstance._publishChangeTo(this);
      if (!this.changePublishers.includes(pluginInstance)) {
        this.changePublishers.push(pluginInstance);
      }
    }
  }

  unsubscribeAllChanges() {
    for (let publisher of this.changePublishers) {
      publisher._unpublishChangeTo(this);
    }
    this.changePublishers = [];
  }

  setChanged(changed) {
    this._changed = changed;
    if (this._changed === true) {
      for (let instance of this.changeSubscribers) {
        instance.setChanged(true);
      }
    }
  }

  isChanged() {
    return this._changed === true;
  }

  fatal(msg) {
    this.log.error(msg);
    throw msg;
  }
}

module.exports = Plugin;