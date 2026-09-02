'use strict';

const path = require('path');
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

const chai = require('chai');
const expect = chai.expect;

const ns = require('../../core/network_setup.js');
const pluginLoader = require('../../plugins/plugin_loader.js');

describe('Test network setup dry-run', function() {
  it('should not run booting_finish during dry-run', async function() {
    const originalReapply = pluginLoader.reapply;
    const originalPostSetup = ns.post_setup;
    const originalBootingFinish = ns.booting_finish;

    let bootingFinishCalled = false;
    let postSetupDryRun;

    try {
      pluginLoader.reapply = async (config, dryRun) => {
        expect(dryRun).to.equal(true);
        return [];
      };

      ns.post_setup = async (dryRun) => {
        postSetupDryRun = dryRun;
      };

      ns.booting_finish = async () => {
        bootingFinishCalled = true;
      };

      const errors = await ns.setup({}, true);

      expect(errors).to.be.empty;
      expect(postSetupDryRun).to.equal(true);
      expect(bootingFinishCalled).to.equal(false);
    } finally {
      pluginLoader.reapply = originalReapply;
      ns.post_setup = originalPostSetup;
      ns.booting_finish = originalBootingFinish;
    }
  });
});
