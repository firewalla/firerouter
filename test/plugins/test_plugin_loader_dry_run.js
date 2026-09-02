'use strict'

const chai = require('chai');
const expect = chai.expect;

const Plugin = require('../../plugins/plugin.js');
const pluginLoader = require('../../plugins/plugin_loader.js');

class DryRunTestPlugin extends Plugin {
  constructor(name) {
    super(name);
  }

  configure(networkConfig) {
    super.configure(networkConfig);

    if (networkConfig.invalid)
      throw new Error('invalid dry-run configuration');
  }
}

describe('Test plugin loader dry-run', function() {
  this.timeout(30000);

  let restorePluginState;

  beforeEach(() => {
    const existing = new DryRunTestPlugin('existing');
    existing.configure({ old: true });
    existing._nextConfig = { old: true };
    existing._reapplyNeeded = false;

    restorePluginState = pluginLoader._setPluginStateForTest(
      [{
        category: 'dry_run_test',
        config_path: 'dry_run_test',
        init_seq: 0,
        allow_concurrent: false,
        c: DryRunTestPlugin,
        config: {}
      }],
      {
        dry_run_test: {
          existing
        }
      }
    );
  });

  afterEach(() => {
    restorePluginState();
  });

  it('should validate config without mutating live plugin state', async () => {
    const existing = pluginLoader.getPluginInstance('dry_run_test', 'existing');
    const beforeConfig = JSON.parse(JSON.stringify(existing.networkConfig));
    const beforeNextConfig = JSON.parse(JSON.stringify(existing._nextConfig));
    const beforeReapplyNeeded = existing._reapplyNeeded;

    const errors = await pluginLoader.reapply({
      dry_run_test: {
        existing: {
          invalid: true
        },
        added: {
          value: true
        }
      }
    }, true);

    expect(errors).to.deep.equal(['invalid dry-run configuration']);

    const afterInstances = pluginLoader.getPluginInstances('dry_run_test');

    expect(afterInstances.existing).to.equal(existing);
    expect(afterInstances.added).to.be.undefined;

    expect(existing.networkConfig).to.deep.equal(beforeConfig);
    expect(existing._nextConfig).to.deep.equal(beforeNextConfig);
    expect(existing._reapplyNeeded).to.equal(beforeReapplyNeeded);
  });

  it('should validate a new plugin without adding it to the live registry', async () => {
    const errors = await pluginLoader.reapply({
      dry_run_test: {
        added: {
          value: true
        }
      }
    }, true);

    expect(errors).to.be.empty;

    const afterInstances = pluginLoader.getPluginInstances('dry_run_test');

    expect(afterInstances.added).to.be.undefined;
  });
});
