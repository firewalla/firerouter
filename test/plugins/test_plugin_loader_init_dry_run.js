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

'use strict';

const assert = require('assert');
const path = require('path');

describe('plugin_loader dry-run initialization', function() {
  this.timeout(10000);

  let pluginLoader;
  let FakePlugin;
  const cachePaths = [];

  function installStub(modulePath, exports) {
    const resolvedPath = require.resolve(modulePath);
    cachePaths.push(resolvedPath);
    require.cache[resolvedPath] = {
      id: resolvedPath,
      filename: resolvedPath,
      loaded: true,
      exports,
    };
  }

  before(async function() {
    FakePlugin = class Plugin {
      static CHANGE_NONE = 0;
      static CHANGE_IP_ONLY = 1;
      static CHANGE_FULL = 2;

      static async preparePlugin() {}

      constructor(name) {
        this.name = name;
        this.networkConfig = null;
        this._nextConfig = null;
        this._reapplyNeeded = false;
        this.changeSubscribers = [];
        this.changePublishers = [];
        if (FakePlugin.constructorObserver)
          FakePlugin.constructorObserver(this);
      }

      init() {
        if (FakePlugin.initObserver)
          FakePlugin.initObserver(this);
      }

      getConfigChangeType() {
        return FakePlugin.CHANGE_FULL;
      }

      propagateConfigChanged(changeType) {
        this._reapplyNeeded = changeType !== FakePlugin.CHANGE_NONE;
      }

      _publishChangeTo(instance) {
        if (instance && !this.changeSubscribers.includes(instance))
          this.changeSubscribers.push(instance);
      }

      _unpublishChangeTo(instance) {
        const index = this.changeSubscribers.indexOf(instance);
        if (index !== -1)
          this.changeSubscribers.splice(index, 1);
      }

      subscribeChangeFrom(instance) {
        if (!instance)
          return;
        instance._publishChangeTo(this);
        if (!this.changePublishers.includes(instance))
          this.changePublishers.push(instance);
      }

      unsubscribeAllChanges() {
        for (const publisher of this.changePublishers)
          publisher._unpublishChangeTo(this);
        this.changePublishers = [];
      }

      isReapplyNeeded() {
        return this._reapplyNeeded;
      }

      isFlushNeeded() {
        return true;
      }

      isFullFlushNeeded() {
        return true;
      }

      async flush() {}

      configure(networkConfig) {
        this.networkConfig = networkConfig;
      }

      async apply() {}
    };
    FakePlugin.constructorObserver = null;
    FakePlugin.initObserver = null;

    const pluginLoaderPath = path.resolve(__dirname, '../../plugins/plugin_loader.js');

    installStub('../../plugins/plugin.js', FakePlugin);

    installStub('../../util/logger.js', () => ({
      info() {},
      error() {},
    }));

    installStub('../../util/config.js', {
      getConfig: () => ({
        plugins: [
          {
            file_path: './plugin.js',
            config_path: 'low',
            category: 'low',
            config: { test: true },
            init_seq: 0,
          },
          {
            file_path: './plugin.js',
            config_path: 'high',
            category: 'high',
            config: { test: true },
            init_seq: 1,
          },
        ],
      }),
    });

    installStub('../../core/Message.js', {
      MSG_FR_CHANGE_APPLIED: 'firerouter.change_applied',
      MSG_FR_IFACE_CHANGE_APPLIED: 'firerouter.iface_change_applied',
      MSG_FR_APC_CHANGE_APPLIED: 'firerouter.apc_change_applied',
    });

    installStub('../../util/redis_manager.js', {
      getPublishClient: () => ({
        publishAsync: async () => {},
      }),
    });

    installStub('../../platform/PlatformLoader.js', {
      getPlatform: () => ({
        prepareWLANRegDomainChange: async () => false,
      }),
    });

    installStub('child-process-promise', {
      exec: async () => ({
        stdout: '',
        stderr: '',
      }),
      execFile: async () => ({
        stdout: '',
        stderr: '',
      }),
    });

    delete require.cache[pluginLoaderPath];
    cachePaths.push(pluginLoaderPath);
    pluginLoader = require(pluginLoaderPath);

    await pluginLoader.initPlugins();
    assert.deepStrictEqual(
      await pluginLoader.reapply({
        low: { lowInstance: { revision: 1 } },
        high: { highInstance: { revision: 1 } },
      }),
      []
    );
  });

  after(function() {
    FakePlugin.constructorObserver = null;
    FakePlugin.initObserver = null;
    for (const resolvedPath of cachePaths)
      delete require.cache[resolvedPath];
  });

  it('resolves constructor and init lookups against candidate plugins', async function() {
    const liveHigh = pluginLoader.getPluginInstance('high', 'highInstance');
    assert(liveHigh, 'expected live high plugin to exist');

    const originalLiveSubscribers = liveHigh.changeSubscribers.slice();
    const originalPublishChangeTo = liveHigh._publishChangeTo;
    let liveSubscriptionAttempts = 0;
    let constructorDependency;
    let initDependency;

    liveHigh._publishChangeTo = function(instance) {
      liveSubscriptionAttempts += 1;
      return originalPublishChangeTo.call(this, instance);
    };

    FakePlugin.constructorObserver = function(instance) {
      if (instance.name === 'lowInstance')
        constructorDependency = pluginLoader.getPluginInstance('high', 'highInstance');
    };

    FakePlugin.initObserver = function(instance) {
      if (instance.name !== 'lowInstance')
        return;
      initDependency = pluginLoader.getPluginInstance('high', 'highInstance');
      instance.subscribeChangeFrom(initDependency);
    };

    try {
      assert.deepStrictEqual(
        await pluginLoader.reapply({
          low: { lowInstance: { revision: 2 } },
          high: { highInstance: { revision: 2 } },
        }, true),
        []
      );
    } finally {
      FakePlugin.constructorObserver = null;
      FakePlugin.initObserver = null;
      liveHigh._publishChangeTo = originalPublishChangeTo;
    }

    assert(constructorDependency, 'constructor should resolve the candidate dependency');
    assert(initDependency, 'init should resolve the candidate dependency');
    assert.notStrictEqual(constructorDependency, liveHigh);
    assert.notStrictEqual(initDependency, liveHigh);
    assert.strictEqual(constructorDependency, initDependency);
    assert.strictEqual(liveSubscriptionAttempts, 0);
    assert.deepStrictEqual(liveHigh.changeSubscribers, originalLiveSubscribers);
    assert.strictEqual(pluginLoader.getPluginInstance('high', 'highInstance'), liveHigh);
  });
});
