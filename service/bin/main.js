#!/usr/bin/env node
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
const port = normalizePort(process.env.PORT || '8833');

let server;

function run() {
  const app = require('../app');
  app.set('port', port);

  /**
   * Create HTTP server.
   */

  server = http.createServer(app);

  /**
   * Listen on provided port, on all network interfaces.
   */

  server.listen(port);
  server.on('error', onError);
  server.on('listening', onListening);

}

run();

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