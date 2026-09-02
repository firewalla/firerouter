'use strict';

const path = require('path');
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

const chai = require('chai');
const expect = chai.expect;

const Plugin = require('../../plugins/plugin.js');
const pluginLoader = require('../../plugins/plugin_loader.js');
const PlatformLoader = require('../../platform/PlatformLoader.js');

class DryRunTestPlugin extends Plugin {
  static constructorCalls = 0;
  static configureCalls = 0;
  static configureArgs = [];
  static liveLifecycleCalls = {
    configure: 0,
    flush: 0,
    flushFast: 0,
    propagateConfigChanged: 0,
    unsubscribeAllChanges: 0
  };

  constructor(name) {
    super(name);
    DryRunTestPlugin.constructorCalls += 1;
    this.trackLiveLifecycle = false;
  }

  async configure(networkConfig) {
    if (this.trackLiveLifecycle)
      DryRunTestPlugin.liveLifecycleCalls.configure += 1;

    DryRunTestPlugin.configureCalls += 1;
    DryRunTestPlugin.configureArgs.push(networkConfig);

    if (!networkConfig.meta)
      networkConfig.meta = {};

    if (!networkConfig.meta.uuid)
      networkConfig.meta.uuid = 'dry-run-test-uuid';

    await super.configure(networkConfig);
  }

  async flush() {
    if (this.trackLiveLifecycle)
      DryRunTestPlugin.liveLifecycleCalls.flush += 1;

    await super.flush();
  }

  async flushFast() {
    if (this.trackLiveLifecycle)
      DryRunTestPlugin.liveLifecycleCalls.flushFast += 1;

    await super.flushFast();
  }

  propagateConfigChanged(changeType) {
    if (this.trackLiveLifecycle)
      DryRunTestPlugin.liveLifecycleCalls.propagateConfigChanged += 1;

    super.propagateConfigChanged(changeType);
  }

  unsubscribeAllChanges() {
    if (this.trackLiveLifecycle)
      DryRunTestPlugin.liveLifecycleCalls.unsubscribeAllChanges += 1;

    super.unsubscribeAllChanges();
  }
}

describe('Test plugin loader dry-run', function() {
  let originalState;
  let originalPrepareWLANRegDomainChange;

  beforeEach(async () => {
    originalState = pluginLoader.__getTestStateForTest();

    DryRunTestPlugin.constructorCalls = 0;
    DryRunTestPlugin.configureCalls = 0;
    DryRunTestPlugin.configureArgs = [];
    DryRunTestPlugin.liveLifecycleCalls = {
      configure: 0,
      flush: 0,
      flushFast: 0,
      propagateConfigChanged: 0,
      unsubscribeAllChanges: 0
    };

    const platform = PlatformLoader.getPlatform();
    originalPrepareWLANRegDomainChange =
      platform.prepareWLANRegDomainChange;
    platform.prepareWLANRegDomainChange = async () => false;

    pluginLoader.__setPluginConfsForTest([{
      category: 'test',
      config_path: 'plugins.test',
      c: DryRunTestPlugin,
      allow_concurrent: false
    }]);

    const upstream = new DryRunTestPlugin('upstream');
    const existing = new DryRunTestPlugin('existing');
    const removed = new DryRunTestPlugin('removed');
    const downstream = new DryRunTestPlugin('downstream');

    await existing.configure({
      enabled: true,
      nested: {
        value: 1
      }
    });

    await removed.configure({
      enabled: true,
      nested: {
        value: 2
      }
    });

    existing._mark = 'existing-mark';
    removed._mark = 'removed-mark';

    existing._nextConfig = {
      enabled: true,
      nested: {
        value: 1
      }
    };

    removed._nextConfig = {
      enabled: true,
      nested: {
        value: 2
      }
    };

    existing._reapplyNeeded = false;
    removed._reapplyNeeded = false;
    downstream._reapplyNeeded = false;

    existing.subscribeChangeFrom(upstream);
    removed.subscribeChangeFrom(upstream);

    downstream.subscribeChangeFrom(existing);
    downstream.subscribeChangeFrom(removed);

    existing.trackLiveLifecycle = true;
    removed.trackLiveLifecycle = true;
    downstream.trackLiveLifecycle = true;

    const liveRegistry = {
      test: {
        existing,
        removed
      }
    };

    pluginLoader.__setPluginCategoryMapForTest(liveRegistry);
  });

  afterEach(() => {
    const platform = PlatformLoader.getPlatform();
    platform.prepareWLANRegDomainChange =
      originalPrepareWLANRegDomainChange;

    pluginLoader.__setPluginConfsForTest(originalState.pluginConfs);
    pluginLoader.__setPluginCategoryMapForTest(
      originalState.pluginCategoryMap
    );
  });

  it(
    'should perform dry-run against isolated plugin instances without mutating the live registry or instances',
    async () => {
      const stateBefore = pluginLoader.__getTestStateForTest();
      const pluginConfsBefore = stateBefore.pluginConfs;
      const liveRegistry = stateBefore.pluginCategoryMap;
      const liveTestCategory = liveRegistry.test;
      const existing = liveTestCategory.existing;
      const removed = liveTestCategory.removed;

      const existingNetworkConfig = JSON.parse(
        JSON.stringify(existing.networkConfig)
      );
      const existingNextConfig = JSON.parse(
        JSON.stringify(existing._nextConfig)
      );
      const existingMark = existing._mark;
      const existingReapplyNeeded = existing._reapplyNeeded;
      const existingPublishers = existing.changePublishers.slice();
      const existingSubscribers = existing.changeSubscribers.slice();

      const removedNetworkConfig = JSON.parse(
        JSON.stringify(removed.networkConfig)
      );
      const removedNextConfig = JSON.parse(
        JSON.stringify(removed._nextConfig)
      );
      const removedMark = removed._mark;
      const removedReapplyNeeded = removed._reapplyNeeded;
      const removedPublishers = removed.changePublishers.slice();
      const removedSubscribers = removed.changeSubscribers.slice();

      const upstream = existing.changePublishers[0];
      const downstream = existing.changeSubscribers[0];

      const upstreamSubscribers = upstream.changeSubscribers.slice();
      const downstreamPublishers = downstream.changePublishers.slice();

      const submittedConfig = {
        plugins: {
          test: {
            existing: {
              enabled: true,
              nested: {
                value: 42
              }
            },
            added: {
              enabled: true,
              nested: {
                value: 99
              }
            }
          }
        }
      };

      const originalSubmittedConfig = JSON.parse(
        JSON.stringify(submittedConfig)
      );

      const errors = await pluginLoader.reapply(
        submittedConfig,
        true
      );

      expect(errors).to.be.empty;

      // The live registry object and category object must remain identical.
      const stateAfter = pluginLoader.__getTestStateForTest();

      expect(stateAfter.pluginConfs).to.equal(pluginConfsBefore);
      expect(stateAfter.pluginCategoryMap).to.equal(liveRegistry);
      expect(stateAfter.pluginCategoryMap.test).to.equal(liveTestCategory);

      // Existing and removed live instances must remain in exactly the same
      // registry slots and must not be replaced or deleted.
      expect(stateAfter.pluginCategoryMap.test.existing)
        .to.equal(existing);
      expect(stateAfter.pluginCategoryMap.test.removed)
        .to.equal(removed);

      // The dry-run candidate must never be inserted into the live registry.
      expect(stateAfter.pluginCategoryMap.test.added)
        .to.be.undefined;

      // Verify live instance state was not changed.
      expect(existing.networkConfig)
        .to.deep.equal(existingNetworkConfig);
      expect(existing._nextConfig)
        .to.deep.equal(existingNextConfig);
      expect(existing._mark)
        .to.equal(existingMark);
      expect(existing._reapplyNeeded)
        .to.equal(existingReapplyNeeded);
      expect(existing.changePublishers)
        .to.deep.equal(existingPublishers);
      expect(existing.changeSubscribers)
        .to.deep.equal(existingSubscribers);

      expect(removed.networkConfig)
        .to.deep.equal(removedNetworkConfig);
      expect(removed._nextConfig)
        .to.deep.equal(removedNextConfig);
      expect(removed._mark)
        .to.equal(removedMark);
      expect(removed._reapplyNeeded)
        .to.equal(removedReapplyNeeded);
      expect(removed.changePublishers)
        .to.deep.equal(removedPublishers);
      expect(removed.changeSubscribers)
        .to.deep.equal(removedSubscribers);

      // Verify unsubscribeAllChanges() was not invoked against live instances.
      expect(upstream.changeSubscribers)
        .to.deep.equal(upstreamSubscribers);
      expect(downstream.changePublishers)
        .to.deep.equal(downstreamPublishers);

      // Verify no live lifecycle method was invoked.
      expect(DryRunTestPlugin.liveLifecycleCalls.configure)
        .to.equal(0);
      expect(DryRunTestPlugin.liveLifecycleCalls.flush)
        .to.equal(0);
      expect(DryRunTestPlugin.liveLifecycleCalls.flushFast)
        .to.equal(0);
      expect(DryRunTestPlugin.liveLifecycleCalls.propagateConfigChanged)
        .to.equal(0);
      expect(DryRunTestPlugin.liveLifecycleCalls.unsubscribeAllChanges)
        .to.equal(0);

      // Verify a downstream live subscriber was not notified by the dry-run.
      expect(downstream._reapplyNeeded)
        .to.equal(false);

      // The production candidate path must still execute.
      expect(DryRunTestPlugin.constructorCalls)
        .to.equal(2);
      expect(DryRunTestPlugin.configureCalls)
        .to.be.greaterThan(0);

      // The caller-owned configuration object must still be isolated.
      expect(DryRunTestPlugin.configureArgs[0])
        .to.not.equal(
          submittedConfig.plugins.test.existing
        );

      expect(submittedConfig)
        .to.deep.equal(originalSubmittedConfig);

      // The plugin is allowed to mutate its isolated working copy.
      expect(DryRunTestPlugin.configureArgs[0])
        .to.have.property('meta');

      expect(DryRunTestPlugin.configureArgs[0].meta.uuid)
        .to.equal('dry-run-test-uuid');
    }
  );
});
