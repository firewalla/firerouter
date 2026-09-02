'use strict'

const chai = require('chai');
const expect = chai.expect;

const Plugin = require('../../plugins/plugin.js');
const pluginLoader = require('../../plugins/plugin_loader.js');

class DryRunTestPlugin extends Plugin {
  constructor(name) {
    super(name);
  }

  init(config) {
    super.init(config);
  }

  configure(networkConfig) {
    super.configure(networkConfig);
  }
}

describe('Test plugin loader dry-run', function() {
  this.timeout(30000);

  let originalPluginConfs;
  let originalPluginInstance;
  let pluginCategoryMap;

  beforeEach(() => {
    originalPluginConfs = pluginLoader.__testPluginConfs;
    originalPluginInstance = pluginLoader.getPluginInstance('dry_run_test', 'existing');

    pluginCategoryMap = pluginLoader.getPluginInstances('dry_run_test');

    if (!pluginCategoryMap) {
      pluginCategoryMap = {};
    }

    pluginLoader.__testPluginConfs = [{
      category: 'dry_run_test',
      config_path: 'dry_run_test',
      init_seq: 0,
      allow_concurrent: false,
      c: DryRunTestPlugin,
      config: {}
    }];
  });

  afterEach(() => {
    pluginLoader.__testPluginConfs = originalPluginConfs;
  });

  it('should not mutate live plugin state during dry-run', async () => {
    const existing = new DryRunTestPlugin('existing');
    existing.configure({ old: true });
    existing._nextConfig = { old: true };
    existing._reapplyNeeded = false;

    /*
     * The production plugin loader does not expose a setter for its
     * internal registry. This assertion is intentionally based on the
     * public registry returned by getPluginInstances().
     */
    const liveInstances = pluginLoader.getPluginInstances('dry_run_test') || {};
    liveInstances.existing = existing;

    const beforeConfig = existing.networkConfig;
    const beforeNextConfig = existing._nextConfig;
    const beforeReapplyNeeded = existing._reapplyNeeded;

    await pluginLoader.reapply({
      dry_run_test: {
        existing: { new: true },
        added: { value: true }
      }
    }, true);

    const afterInstances =
      pluginLoader.getPluginInstances('dry_run_test') || {};

    expect(afterInstances.existing).to.equal(existing);
    expect(afterInstances.added).to.be.undefined;

    expect(existing.networkConfig).to.deep.equal(beforeConfig);
    expect(existing._nextConfig).to.deep.equal(beforeNextConfig);
    expect(existing._reapplyNeeded).to.equal(beforeReapplyNeeded);
  });
});
