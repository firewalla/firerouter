/*    Copyright 2020 Firewalla Inc
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
const log = require('../../util/logger.js')(__filename);
const r = require('../../util/firerouter.js');
const jsonParser = bodyParser.json();

router.post('/switch_branch', jsonParser, async (req, res, next) => {
  const targetBranch = req.body.target;
  const supportedBranches = {
    "release": "release_6_0",
    "beta": "beta_6_0",
    "alpha": "beta_7_0",
    "master": "master"
  };
  if (!targetBranch || !supportedBranches[targetBranch]) {
    res.status(400).json({errors: ["Not a valid target branch"]});
  } else {
    // the whole service will be rebooted shortly after the function returns
    await r.switchBranch(supportedBranches[targetBranch]).then(() => {
      res.status(200).json({errors: []});
    }).catch((err) => {
      res.status(500).json({errors: [err.message]});
    });
  }
  
});

module.exports = router;