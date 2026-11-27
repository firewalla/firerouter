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

const chai = require('chai');
const expect = chai.expect;

const ncm = require('../../core/network_config_mgr.js');
const configRouter = require('../../service/routes/config.js');

describe('Test config service routes', function() {
  this.timeout(30000);

  /*
   * The /set route is registered as:
   *
   *   router.post('/set', jsonParser, async handler)
   *
   * We intentionally invoke only the final route handler here because the
   * test supplies an already-parsed req.body. This keeps the regression test
   * focused on the transactionOp control flow without adding another HTTP
   * testing dependency.
   */
  const getHandler = (path) => {
    const layer = configRouter.stack.find(
      (entry) => entry.route && entry.route.path === path
    );

    expect(layer, `POST ${path} route should be registered`).to.exist;

    const handlers = layer.route.stack.map((entry) => entry.handle);
    const handler = handlers[handlers.length - 1];

    expect(handler, `POST ${path} route handler should be registered`).to.be.a('function');

    return handler;
  };

  const getSetHandler = () => getHandler('/set');

  const createResponse = () => {
    const response = {
      statusCalls: [],
      jsonCalls: [],
      status(code) {
        this.statusCalls.push(code);
        return this;
      },
      json(payload) {
        this.jsonCalls.push(payload);
        return this;
      },
    };

    return response;
  };

  it('should reject an unknown transactionOp before config processing', async () => {
    const originalAcquireConfigRWLock = ncm.acquireConfigRWLock;
    const originalValidateConfig = ncm.validateConfig;
    const originalValidateNcidOrReqId = ncm.validateNcidOrReqId;
    const originalTryApplyConfig = ncm.tryApplyConfig;
    const originalSaveConfig = ncm.saveConfig;

    let acquireConfigRWLockCalls = 0;
    let validateConfigCalls = 0;
    let validateNcidOrReqIdCalls = 0;
    let tryApplyConfigCalls = 0;
    let saveConfigCalls = 0;

    try {
      /*
       * Execute the route's callback immediately instead of acquiring the
       * real config lock. This keeps the test isolated from Redis and avoids
       * changing lock state on the host running the test.
       */
      ncm.acquireConfigRWLock = async (callback) => {
        acquireConfigRWLockCalls++;
        return callback();
      };

      ncm.validateConfig = async () => {
        validateConfigCalls++;
        return [];
      };

      ncm.validateNcidOrReqId = async () => {
        validateNcidOrReqIdCalls++;
        return [];
      };

      ncm.tryApplyConfig = async () => {
        tryApplyConfigCalls++;
        return [];
      };

      ncm.saveConfig = async () => {
        saveConfigCalls++;
      };

      const req = {
        body: {
          transactionOp: 'bogus',
          version: 1,
        },
        url: '/set',
      };

      const res = createResponse();

      const handler = getSetHandler();
      await handler(req, res, () => {});

      expect(acquireConfigRWLockCalls)
        .to.equal(1, 'config lock wrapper should be entered once');

      expect(res.statusCalls)
        .to.deep.equal([400], 'invalid transactionOp should produce exactly one 400 response');

      expect(res.jsonCalls)
        .to.have.length(1, 'invalid transactionOp should produce exactly one response body');

      expect(res.jsonCalls[0])
        .to.deep.equal({
          errors: ['Unrecognized transactionOp in config: bogus'],
        });

      /*
       * These assertions are the important regression checks.
       *
       * With the known-buggy implementation, validateConfig() is reached
       * after the 400 response, so at least validateConfigCalls will be 1.
       * The fixed implementation returns immediately and therefore all
       * configuration-processing methods remain untouched.
       */
      expect(validateConfigCalls)
        .to.equal(0, 'validateConfig must not run after rejecting transactionOp');

      expect(validateNcidOrReqIdCalls)
        .to.equal(0, 'validateNcidOrReqId must not run after rejecting transactionOp');

      expect(tryApplyConfigCalls)
        .to.equal(0, 'tryApplyConfig must not run after rejecting transactionOp');

      expect(saveConfigCalls)
        .to.equal(0, 'saveConfig must not run after rejecting transactionOp');
    } finally {
      ncm.acquireConfigRWLock = originalAcquireConfigRWLock;
      ncm.validateConfig = originalValidateConfig;
      ncm.validateNcidOrReqId = originalValidateNcidOrReqId;
      ncm.tryApplyConfig = originalTryApplyConfig;
      ncm.saveConfig = originalSaveConfig;
    }
  });

  // validateConfig takes `incoming` so that a check meant for new input does not refuse a saved
  // config at boot or on revert
  describe('validateConfig incoming option', function() {
    const methods = ['acquireConfigRWLock', 'validateConfig', 'validateNcidOrReqId', 'tryApplyConfig',
      'saveConfig', 'getActiveConfig'];
    const originals = {};
    let validateCalls;

    beforeEach(() => {
      for (const m of methods)
        originals[m] = ncm[m];
      validateCalls = [];
      ncm.acquireConfigRWLock = async (callback) => callback();
      ncm.validateConfig = async (config, options) => {
        validateCalls.push(options);
        return [];
      };
      ncm.validateNcidOrReqId = async () => [];
      ncm.tryApplyConfig = async () => [];
      ncm.saveConfig = async () => {};
      ncm.getActiveConfig = async () => ({ interface: {}, saved: true });
    });

    afterEach(() => {
      for (const m of methods)
        ncm[m] = originals[m];
    });

    const post = async (path, body) => {
      const res = createResponse();
      await getHandler(path)({ body, url: path }, res, () => {});
      return res;
    };

    it('should validate a config posted to /set as incoming', async () => {
      const res = await post('/set', { interface: {} });
      expect(res.statusCalls).to.deep.equal([200]);
      expect(validateCalls).to.deep.equal([{ incoming: true }]);
    });

    it('should not validate the persisted config of a revert as incoming', async () => {
      let res = await post('/set', { interface: {}, transactionOp: 'append', transID: 't1' });
      expect(res.statusCalls).to.deep.equal([200]);
      res = await post('/set', { transactionOp: 'revert', transID: 't1' });
      expect(res.statusCalls).to.deep.equal([200]);
      expect(validateCalls).to.deep.equal([{ incoming: true }, { incoming: false }]);
    });

    it('should not validate the saved config of apply_current_config as incoming', async () => {
      const res = await post('/apply_current_config', {});
      expect(res.statusCalls).to.deep.equal([200]);
      expect(validateCalls).to.have.length(1);
      expect(validateCalls[0]).to.not.exist;
    });
  });
});
