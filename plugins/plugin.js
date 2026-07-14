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

  /**
   * Returns true if a full flush() is needed before apply(), if this function returns false, flushFast() will be called instead.
   *
   */
  isFullFlushNeeded(newConfig) {
    return true;
  }

  /**
   * This function will be called if isFullFlushNeeded() returns false.
   * So make sure this function and isFullFlushNeeded() are logically consistent.
   */
  async flushFast() {
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

  /**
   * Propagate config change to this plugin and all change subscribers.
   * @param {string|boolean} changeType - Plugin.CHANGE_NONE (false) = no change;
   *   Plugin.CHANGE_FULL ('full') or true = full reapply;
   *   Plugin.CHANGE_IP_ONLY = incremental (subscribers may do light update).
   */
  propagateConfigChanged(changeType) {
    this.onConfigChanged(changeType);
    if (changeType) {
      for (let instance of this.changeSubscribers) {
        instance.propagateConfigChanged(changeType);
      }
    }
  }

  onConfigChanged(changeType) {
    this._reapplyNeeded = (changeType !== Plugin.CHANGE_NONE);
  }

  /**
   * Returns the config change type when given newConfig (e.g. from loader);
   * Override to compute type from this.networkConfig vs newConfig (e.g. return CHANGE_IP_ONLY when only IP keys differ).
   * @param {object} [newConfig] - If provided, return the change type for the transition to this config;
   * @returns {string} Plugin.CHANGE_FULL, Plugin.CHANGE_IP_ONLY, or Plugin.CHANGE_NONE.
   */
  getConfigChangeType(newConfig) {
    return Plugin.CHANGE_FULL;
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

/**
 * Config change types for propagateConfigChanged().
 * - true or 'full': full reapply (flush + apply) needed
 * - false: no reapply
 * - 'ip_only': only IP-related fields changed; dependents may do incremental update
 */
Plugin.CHANGE_NONE = false;
Plugin.CHANGE_FULL = 'full';
Plugin.CHANGE_IP_ONLY = 'ip_only';

module.exports = Plugin;