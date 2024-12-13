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

class Plugin {
  constructor(name) {
    this.name = name;
    this.changeSubscribers = [];
    this.changePublishers = []
    this.log = require('../util/logger.js')(this.constructor.name);
    return this;
  }

  isFlushNeeded(newConfig) {
    return true;
  }

  static async preparePlugin() {

  }

  init(pluginConfig) {
    this.pluginConfig = pluginConfig;
    this.log.info(`Initializing Plugin ${this.constructor.name} ${JSON.stringify(pluginConfig)}...`);
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

  getRecursiveSubscriberPlugins() {
    const subscribers = [].concat(this.changeSubscribers); // return a new array, do not touch this.changeSubscribers
    for (const subscriber of this.changeSubscribers) {
      const recursiveSubscribers = subscriber.getRecursiveSubscriberPlugins();
      for (const s of recursiveSubscribers) {
        if (!subscribers.includes(s))
          subscribers.push(s);
      }
    }
    return subscribers;
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

  propagateConfigChanged(changed) {
    this.onConfigChanged(changed);
    if (changed === true) {
      for (let instance of this.changeSubscribers) {
        instance.propagateConfigChanged(true);
      }
    }
  }

  onConfigChanged(changed) {
    this._reapplyNeeded = changed;
  }

  propagateEvent(event) {
    this.onEvent(event);
    for (let instance of this.changeSubscribers) {
      instance.propagateEvent(event);
    }
  }

  onEvent(e) {

  }

  isReapplyNeeded() {
    return this._reapplyNeeded === true;
  }

  fatal(msg) {
    this.log.error(msg);
    throw msg;
  }
}

module.exports = Plugin;