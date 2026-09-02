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

describe('plugin_loader', function() {
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
      }

      init() {}

      getConfigChangeType() {
        return FakePlugin.CHANGE_FULL;
      }

      propagateConfigChanged(changeType) {
        this._reapplyNeeded = changeType !== FakePlugin.CHANGE_NONE;
      }

      unsubscribeAllChanges() {}

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

      async apply() {
        FakePlugin.applyOrder.push(this.name);
      }
    };
    FakePlugin.applyOrder = [];

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
            init_seq: 0,
          },
          {
            file_path: './plugin.js',
            config_path: 'high',
            category: 'high',
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
    });

    delete require.cache[pluginLoaderPath];
    cachePaths.push(pluginLoaderPath);
    pluginLoader = require(pluginLoaderPath);

    await pluginLoader.initPlugins();
  });

  after(function() {
    for (const resolvedPath of cachePaths)
      delete require.cache[resolvedPath];
  });

  it('preserves plugin apply ordering after a failed removal flush', async function() {
    FakePlugin.applyOrder.length = 0;

    const initialConfig = {
      low: {
        lowInstance: {
          revision: 1,
        },
      },
      high: {
        highInstance: {
          revision: 1,
        },
      },
    };

    assert.deepStrictEqual(
      await pluginLoader.reapply(initialConfig),
      [],
      'initial apply should succeed'
    );

    const highInstance = pluginLoader.getPluginInstance('high', 'highInstance');
    assert(highInstance, 'expected high instance to exist after initial apply');

    let rejectFlush = true;
    highInstance.flush = async function() {
      if (rejectFlush) {
        rejectFlush = false;
        throw new Error('expected flush failure');
      }
    };

    const removalConfig = {
      low: {
        lowInstance: {
          revision: 2,
        },
      },
    };

    const firstErrors = await pluginLoader.reapply(removalConfig);

    assert.deepStrictEqual(
      firstErrors,
      ['expected flush failure'],
      'failed removal must be reported'
    );

    FakePlugin.applyOrder.length = 0;

    const recoveryConfig = {
      low: {
        lowInstance: {
          revision: 3,
        },
      },
      high: {
        highInstance: {
          revision: 3,
        },
      },
    };

    assert.deepStrictEqual(
      await pluginLoader.reapply(recoveryConfig),
      [],
      'reapply after the failed removal should succeed'
    );

    assert.deepStrictEqual(
      FakePlugin.applyOrder,
      ['lowInstance', 'highInstance'],
      'plugins must still apply in ascending init_seq order'
    );
  });
});
