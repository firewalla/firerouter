/*    Copyright 2019-2023 Firewalla Inc.
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
const jsonParser = bodyParser.json();

const assetsController = require('../../core/assets_controller.js');

router.get('/ap/status', async (req, res, next) => {
  await assetsController.getAllAPAssetsStatus().then((info) => {
    if (info)
      res.status(200).json({errors: [], info});
    else
      res.status(500).json({errors: [`Failed to get assets status`]});
  }).catch((err) => {
    res.status(500).json({errors: [err.message]});
  });
});

router.get('/ap/sta_status', async (req, res, next) => {
  await assetsController.getAllAPSTAStatus().then((info) => {
    if (info)
      res.status(200).json({errors: [], info});
    else
      res.status(500).json({errors: [`Failed to get STA status`]});
  }).catch((err) => {
    res.status(500).json({errors: [err.message]});
  });
});

router.post('/ap/bss_steer', jsonParser, async (req, res, next) => {
  const {staMAC, targetAP, targetSSID, targetBand} = req.body;
  await assetsController.bssSteer(staMAC, targetAP, targetSSID, targetBand).then(() => res.status(200).json({errors: []})).catch((err) => {
    res.status(500).json({errors: [err.message]});
  });
});


module.exports = router;