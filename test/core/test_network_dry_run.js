/*    Copyright 2019-2026 Firewalla Inc.
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

const path = require('path');
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

const chai = require('chai');
const expect = chai.expect;

const ns = require('../../core/network_setup.js');
const ncm = require('../../core/network_config_mgr.js');

describe('Test dry-run network setup', function() {
  this.timeout(30000);

  describe('NetworkSetup.setup()', function() {
    let originalBootingFinish;

    beforeEach(() => {
      originalBootingFinish = ns.booting_finish;
      ns.booting_finish = async function() {};
    });

    afterEach(() => {
      ns.booting_finish = originalBootingFinish;
    });

    it('should not call booting_finish during dry-run', async () => {
      let bootingFinishCalls = 0;

      ns.booting_finish = async function() {
        bootingFinishCalls += 1;
      };

      const pluginLoader = require('../../plugins/plugin_loader.js');

      pluginLoader.reapply = async function(config, dryRun) {
        expect(dryRun).to.equal(true);
        return [];
      };

      try {
        await ns.setup({}, true);
        expect(bootingFinishCalls).to.equal(0);
      } finally {
        pluginLoader.reapply = originalReapply;
      }
    });

    it('should call booting_finish during normal setup', async () => {
      let bootingFinishCalls = 0;

      ns.booting_finish = async function() {
        bootingFinishCalls += 1;
      };

      const originalReapply = require('../../plugins/plugin_loader.js').reapply;
      const pluginLoader = require('../../plugins/plugin_loader.js');

      pluginLoader.reapply = async function(config, dryRun) {
        expect(dryRun).to.equal(false);
        return [];
      };

      try {
        await ns.setup({}, false);
        expect(bootingFinishCalls).to.equal(1);
      } finally {
        pluginLoader.reapply = originalReapply;
      }
    });
  });

  describe('NetworkConfigManager.tryApplyConfig()', function() {
    let originalGetActiveConfig;
    let originalGetDefaultConfig;
    let originalConvertIntegratedAPConfig;
    let originalSetup;

    beforeEach(() => {
      originalGetActiveConfig = ncm.getActiveConfig;
      originalGetDefaultConfig = ncm.getDefaultConfig;
      originalConvertIntegratedAPConfig = ncm.convertIntegratedAPConfig;
      originalSetup = ns.setup;

      ncm.getActiveConfig = async function() {
        return {
          marker: 'current'
        };
      };

      ncm.getDefaultConfig = async function() {
        return {
          marker: 'default'
        };
      };

      ncm.convertIntegratedAPConfig = async function(config) {
        return config;
      };
    });

    afterEach(() => {
      ncm.getActiveConfig = originalGetActiveConfig;
      ncm.getDefaultConfig = originalGetDefaultConfig;
      ncm.convertIntegratedAPConfig = originalConvertIntegratedAPConfig;
      ns.setup = originalSetup;
    });

    it('should not rollback the live configuration after a failed dry-run', async () => {
      const setupCalls = [];

      ns.setup = async function(config, dryRun) {
        setupCalls.push({
          config,
          dryRun
        });

        return [new Error('validation failed')];
      };

      const proposedConfig = {
        marker: 'proposed'
      };

      const errors = await ncm.tryApplyConfig(proposedConfig, true);

      expect(errors).to.have.lengthOf(1);
      expect(setupCalls).to.have.lengthOf(1);
      expect(setupCalls[0].config).to.equal(proposedConfig);
      expect(setupCalls[0].dryRun).to.equal(true);
    });

    it('should rollback the live configuration after a failed normal apply', async () => {
      const setupCalls = [];

      const currentConfig = {
        marker: 'current'
      };

      const proposedConfig = {
        marker: 'proposed'
      };

      ncm.getActiveConfig = async function() {
        return currentConfig;
      };

      ns.setup = async function(config, dryRun) {
        setupCalls.push({
          config,
          dryRun
        });

        if (setupCalls.length === 1)
          return [new Error('apply failed')];

        return [];
      };

      const errors = await ncm.tryApplyConfig(proposedConfig, false);

      expect(errors).to.have.lengthOf(1);
      expect(setupCalls).to.have.lengthOf(2);

      expect(setupCalls[0].config).to.equal(proposedConfig);
      expect(setupCalls[0].dryRun).to.equal(false);

      expect(setupCalls[1].config).to.equal(currentConfig);
      expect(setupCalls[1].dryRun).to.equal(undefined);
    });
  });
});
