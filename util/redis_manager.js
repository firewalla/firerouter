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

const redis = require('redis')
const log = require('./logger.js')(__filename)

const Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

class RedisManager {
  constructor() {
    this.rclient = {};
  }

  getPrimaryDBRedisClient() {
    return this.getRedisClient(0);
  }

  getRedisClient(db = 1) {
    if(!this.rclient[db]) {
      const rclient = redis.createClient({
        host: "localhost",
        db: db
      });
      rclient.on('error', (err) => {
        log.error("Redis client got error:", err);
      });
      this.rclient[db] = rclient;
    }
    return this.rclient[db];
  }

  getSubscriptionClient() {
    if(!this.sclient) {
      this.sclient = redis.createClient();
      this.sclient.setMaxListeners(0)
      this.sclient.on('error', (err) => {
        log.error("Redis sclient got error:", err);
      });
    }
    return this.sclient;
  }

  getPublishClient() {
    if(!this.pclient) {
      this.pclient = redis.createClient();
      this.pclient.setMaxListeners(0);
      this.pclient.on('error', (err) => {
        log.error("Redis pclient got error:", err);
      });
    }
    return this.pclient;
  }
}

module.exports = new RedisManager()
