/*    Copyright 2018-2019 Firewalla INC
 *
 *    This program is free software: you can redistribute it and/or  modify
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
const path = require('path');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const swagger = require("swagger-node-express");
const log = require('../util/logger.js')(__filename, 'info')

const app = express();

app.use(morgan('combined'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

var subpath_v1 = express();
app.use("/v1", subpath_v1);
subpath_v1.use(bodyParser.json());
subpath_v1.use(bodyParser.urlencoded({ extended: false }));

function enableSubPath(path, lib) {
  lib = lib || path;
  let r = require(`./routes/${lib}.js`);
  subpath_v1.use("/" + path, r);
}

// encipher api is enabled even for production enviornment
enableSubPath('config');
enableSubPath('interface');

const subpath_docs = express();
subpath_v1.use("/docs", subpath_docs);
subpath_docs.use("/", express.static('dist'));

swagger.setAppHandler(subpath_docs);

subpath_docs.get('/', function (req, res) {
  res.sendfile(__dirname + '/dist/index.html');
});

const domain = require('ip').address;
let applicationUrl = 'http://' + domain + "/v1";
swagger.configureSwaggerPaths('', '/docs/', '');
swagger.configure(applicationUrl, '1.0.0');

swagger.setApiInfo({
  title: "FireRouter Network Config API",
  description: "API to do something, manage something...",
  termsOfServiceUrl: "",
  contact: "help@firewalla.com",
  license: "",
  licenseUrl: "",
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    log.error("[Developerment] Got error when handling request:", err, err.stack);
    res.status(err.status || 500);
    res.json({
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  log.error("Got error when handling request: ", err, err.stack);
  res.status(err.status || 500);
  res.json({
    message: err.message,
    error: {}
  });
});


module.exports = app;
