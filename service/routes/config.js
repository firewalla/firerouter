/*    Copyright 2019 Firewalla Inc
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

const express = require('express');
const router = express.Router();
const bodyParser = require('body-parser');
const log = require('../../util/logger.js')(__filename, 'info')
const ncm = require('../../core/network_config_mgr');

router.get('/active', async (req, res, next) => {
  const config = await ncm.getActiveConfig();
  if(config) {
    res.json(config);
  } else {
    res.status(404).send('');
  }
});

const jsonParser = bodyParser.json()

router.post('/set',
  jsonParser,
  async (req, res, next) => {
    const newConfig = req.body;
    let errors = await ncm.validateConfig(newConfig);
    if (errors && errors.length != 0) {
      log.error("Invalid network config", errors);
      res.json({errors: errors});
    } else {
      errors = await ncm.tryApplyConfig(newConfig);
      if (errors && errors.length != 0) {
        log.error("Failed to apply new network config", errors);
        res.status(400).json({errors: errors});
      } else {
        log.info("New config is applied with no error");
        await ncm.saveConfig(newConfig);
        res.status(200).json({errors: errors});
      }
    }
  });

router.post('/apply_current_config',
  jsonParser,
  async (req, res, next) => {
    const currentConfig = await ncm.getActiveConfig();
    if (currentConfig) {
      let errors = await ncm.validateConfig(currentConfig);
      if (errors && errors.length != 0) {
        log.error("Invalid network config", errors);
        res.json({errors: errors});
      } else {
        errors = await ncm.tryApplyConfig(currentConfig);
        if (errors && errors.length != 0) {
          log.error("Failed to apply current network config", errors);
          res.status(400).json({errors: errors});
        } else {
          log.info("Current config is applied with no error");
          await ncm.saveConfig(currentConfig);
          res.status(200).json({errors: errors});
        }
      }
    } else {
      res.status(404).send("Network config is not set.");
    }
  });

module.exports = router;
