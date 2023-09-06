/*    Copyright 2019-2021 Firewalla Inc.
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
const storage = require('../../util/storage.js');
const jsonParser = bodyParser.json();

router.post('/save_txt_file', jsonParser, async (req, res, next) => {
  const config = req.body;
  if (!config || !config.filename || !config.content) {
    res.status(400).json({ errors: ['Either "filename" or "content" is not specified.'] });
  } else {
    await storage.saveFile(config.filename, config.content).then(() => {
      res.status(200).json({});
    }).catch((err) => {
      res.status(500).json({ errors: [err.message] });
    });
  }
});

router.post('/load_txt_file', jsonParser, async (req, res, next) => {
  const filename = req.body && req.body.filename;
  if (!filename) {
    res.status(400).json({errors: ['"filename" is not specified.']});
  } else {
    await storage.loadFile(filename).then(content => {
      res.status(200).json({content});
    }).catch((err) => {
      res.status(500).json({errors: [err.message]});
    });
  }
});

router.post('/remove_file', jsonParser, async (req, res, next) => {
  const filename = req.body && req.body.filename;
  if (!filename) {
    res.status(400).json({errors: ['"filename" is not specified.']});
  } else {
    await storage.removeFile(filename).then(() => {
      res.status(200).json({});
    }).catch((err) => {
      res.status(500).json({errors: [err.message]});
    });
  }
});

router.get('/filenames', async (req, res, next) => {
  await storage.listSavedFileNames().then(files => {
    res.status(200).json({filenames: files});
  }).catch((err) => {
    res.status(500).json({errors: [err.message]});
  });
});

module.exports = router;