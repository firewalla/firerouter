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

  constructor(name) {
    super(name);
    DryRunTestPlugin.constructorCalls += 1;
  }

  async configure(networkConfig) {
    DryRunTestPlugin.configureCalls += 1;
    DryRunTestPlugin.configureArgs.push(networkConfig);

    // Deliberately mutate the configuration the loader supplies. This mirrors
    // the behavior that makes a dry-run unsafe when the caller-owned object
    // is passed directly into configure().
    if (!networkConfig.meta)
      networkConfig.meta = {};

    if (!networkConfig.meta.uuid)
      networkConfig.meta.uuid = 'dry-run-test-uuid';

    await super.configure(networkConfig);
  }
}

describe('Test plugin loader dry-run', function() {
  let originalState;
  let originalPrepareWLANRegDomainChange;

  beforeEach(() => {
    originalState = pluginLoader.__getTestStateForTest();

    DryRunTestPlugin.constructorCalls = 0;
    DryRunTestPlugin.configureCalls = 0;
    DryRunTestPlugin.configureArgs = [];

    const platform = PlatformLoader.getPlatform();
    originalPrepareWLANRegDomainChange =
      platform.prepareWLANRegDomainChange;

    platform.prepareWLANRegDomainChange = async () => false;

    // Explicitly configure the loader under test instead of mutating an
    // unrelated/local object that plugin_loader.js never reads.
    pluginLoader.__setPluginConfsForTest([{
      category: 'test',
      config_path: 'plugins.test',
      c: DryRunTestPlugin,
      allow_concurrent: false
    }]);

    pluginLoader.__setPluginCategoryMapForTest({
      test: {}
    });
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
    'should instantiate/configure the test plugin without mutating submitted config during dry-run',
    async () => {
      const candidate = {
        enabled: true,
        nested: {
          value: 42
        }
      };

      const submittedConfig = {
        plugins: {
          test: {
            existing: candidate
          }
        }
      };

      const originalCandidate = JSON.parse(
        JSON.stringify(candidate)
      );

      const errors = await pluginLoader.reapply(
        submittedConfig,
        true
      );

      expect(errors).to.be.empty;

      // Prove the loader used the injected test plugin configuration and
      // that the production instance-creation/configuration path executed.
      expect(DryRunTestPlugin.constructorCalls).to.equal(1);
      expect(DryRunTestPlugin.configureCalls).to.be.greaterThan(0);

      // The loader must not pass the caller-owned object directly to
      // configure() during dry-run.
      expect(DryRunTestPlugin.configureArgs[0])
        .to.not.equal(candidate);

      // configure() deliberately mutates its argument, so this assertion
      // fails on the buggy loader and passes only when the dry-run candidate
      // is cloned.
      expect(candidate).to.deep.equal(originalCandidate);

      expect(submittedConfig.plugins.test.existing)
        .to.deep.equal(originalCandidate);

      // The plugin is allowed to mutate its private working copy.
      expect(DryRunTestPlugin.configureArgs[0])
        .to.have.property('meta');

      expect(DryRunTestPlugin.configureArgs[0].meta.uuid)
        .to.equal('dry-run-test-uuid');
    }
  );
});
