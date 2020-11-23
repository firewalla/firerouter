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

'use strict'

process.title = "FireRouter"
process.setMaxListeners(0)
require('events').EventEmitter.prototype._maxListeners = 100;

const log = require("../../util/logger.js")(__filename);

log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
log.info("Router Service Starting ");
log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");

const debug = require('debug')('api:server');
const http = require('http');
const port = normalizePort(process.env.PORT || '8837');

const pl = require('../../plugins/plugin_loader.js');
const sl = require('../../sensors/sensor_loader.js');
const ncm = require('../../core/network_config_mgr.js');
const r = require('../../util/firerouter.js');
const fwpclient = require('../util/redis_manager.js').getPublishClient();

let server;

async function pre_run() {

  await pl.initPlugins();
  await sl.initSensors();
  const activeConfig = ( await ncm.getActiveConfig()) || (await ncm.getDefaultConfig());
  await ncm.tryApplyConfig(activeConfig, true);
  await ncm.saveConfig(activeConfig);
  await fwpclient.publishAsync("FIREWALLA:HEARTBEAT:UPDATE", JSON.stringify({"invoked-by":"firerouter"}));
  log.info("Booting setup complete.");
}

function run() {
  const app = require('../app');
  app.set('port', port);

  /**
   * Create HTTP server.
   */

  server = http.createServer(app);

  /**
   * Listen on provided port, on localhost only unless it is development branch.
   */

  if (r.isProductionOrBetaOrAlpha()) {
    server.listen(port, 'localhost');
  } else {
    server.listen(port);
  }
  server.on('error', onError);
  server.on('listening', onListening);

}

pre_run().then(() => run());

function normalizePort(val) {
  var port = parseInt(val, 10);

  if (isNaN(port)) {
    // named pipe
    return val;
  }

  if (port >= 0) {
    // port number
    return port;
  }

  return false;
}

/**
 * Event listener for HTTP server "error" event.
 */

function onError(error) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  var bind = typeof port === 'string'
    ? 'Pipe ' + port
    : 'Port ' + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */

function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string'
    ? 'pipe ' + addr
    : 'port ' + addr.port;
  debug('Listening on ' + bind);
}

process.on('uncaughtException',(err)=> {
  log.info("################### CRASH #############");
  log.info("+-+-+-", err.message, err.stack);
  if (err && err.message && err.message.includes("Redis connection")) {
    return;
  }
  setTimeout(() => {
    process.exit(1);
  }, 1000 * 2);
});
