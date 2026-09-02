/*    Copyright 2016-2026 Firewalla Inc.
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

const chai = require('chai');
const expect = chai.expect;

const ncm = require('../../core/network_config_mgr.js');
const ns = require('../../core/network_setup.js');

describe('Test network config manager dry-run', function() {
  it('should not rollback with a live setup after a failed dry-run', async function() {
    const originalGetActiveConfig = ncm.getActiveConfig;
    const originalGetDefaultConfig = ncm.getDefaultConfig;
    const originalConvertIntegratedAPConfig = ncm.convertIntegratedAPConfig;
    const originalSetup = ns.setup;

    const setupCalls = [];
    const candidateConfig = { candidate: true };

    try {
      ncm.getActiveConfig = async () => ({ active: true });
      ncm.getDefaultConfig = async () => ({ default: true });
      ncm.convertIntegratedAPConfig = async (config) => config;

      ns.setup = async (config, dryRun = false) => {
        setupCalls.push({ config, dryRun });
        return ['configuration error'];
      };

      const errors = await ncm.tryApplyConfig(candidateConfig, true);

      expect(errors).to.deep.equal(['configuration error']);
      expect(setupCalls).to.have.length(1);
      expect(setupCalls[0].config).to.equal(candidateConfig);
      expect(setupCalls[0].dryRun).to.equal(true);
    } finally {
      ncm.getActiveConfig = originalGetActiveConfig;
      ncm.getDefaultConfig = originalGetDefaultConfig;
      ncm.convertIntegratedAPConfig = originalConvertIntegratedAPConfig;
      ns.setup = originalSetup;
    }
  });

  it('should rollback with a live setup after a failed non-dry-run', async function() {
    const originalGetActiveConfig = ncm.getActiveConfig;
    const originalGetDefaultConfig = ncm.getDefaultConfig;
    const originalConvertIntegratedAPConfig = ncm.convertIntegratedAPConfig;
    const originalSetup = ns.setup;

    const setupCalls = [];
    const currentConfig = { current: true };
    const candidateConfig = { candidate: true };

    try {
      ncm.getActiveConfig = async () => currentConfig;
      ncm.getDefaultConfig = async () => ({ default: true });
      ncm.convertIntegratedAPConfig = async (config) => config;

      ns.setup = async (config, dryRun = false) => {
        setupCalls.push({ config, dryRun });

        if (setupCalls.length === 1)
          return ['configuration error'];

        return [];
      };

      const errors = await ncm.tryApplyConfig(candidateConfig, false);

      expect(errors).to.deep.equal(['configuration error']);
      expect(setupCalls).to.have.length(2);

      expect(setupCalls[0].config).to.equal(candidateConfig);
      expect(setupCalls[0].dryRun).to.equal(false);

      expect(setupCalls[1].config).to.equal(currentConfig);
      expect(setupCalls[1].dryRun).to.equal(false);
    } finally {
      ncm.getActiveConfig = originalGetActiveConfig;
      ncm.getDefaultConfig = originalGetDefaultConfig;
      ncm.convertIntegratedAPConfig = originalConvertIntegratedAPConfig;
      ns.setup = originalSetup;
    }
  });
});
