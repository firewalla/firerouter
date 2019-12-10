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

const log = require("./logger.js")(__filename, "info");

const fs = require('fs');

const r = require('./firerouter');

let config = null;
let userConfig = null;

const util = require('util');
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);

const configFilename = "routeConfig.json";
const configTestFilename = "routeConfig.test.json";

async function updateUserConfig(updatedPart) {
  await getUserConfig(true);
  userConfig = Object.assign({}, userConfig, updatedPart);
  let userConfigFile = r.getUserConfigFolder() + "/" + configFilename;
  await writeFileAsync(userConfigFile, JSON.stringify(userConfig, null, 2), 'utf8'); // pretty print
  getConfig(true);
}

async function getUserConfig(reload) {
  if (!userConfig || reload === true) {
    let userConfigFile = r.getUserConfigFolder() + "/" + configFilename;
    userConfig = {};
    if (fs.existsSync(userConfigFile)) {
      userConfig = JSON.parse(await readFileAsync(userConfigFile, 'utf8'));
    }
  }
  return userConfig;
}

function getConfig(reload) {
  if(!config || reload === true) {
    let defaultConfig = JSON.parse(fs.readFileSync(r.getFireRouterHome() + "/config/config.json", 'utf8'));
    let userConfigFile = r.getUserConfigFolder() + "/" + configFilename;
    userConfig = {};
    try {
      if(fs.existsSync(userConfigFile)) {
        userConfig = JSON.parse(fs.readFileSync(userConfigFile, 'utf8'));
      }
    } catch(err) {
      log.error("Error parsing user config");
    }

    let testConfig = {};
    if(process.env.NODE_ENV === 'test') {
      let testConfigFile = r.getUserConfigFolder() + "/" + configTestFilename;
      if(fs.existsSync(testConfigFile)) {
        testConfig = JSON.parse(fs.readFileSync(testConfigFile, 'utf8'));
        log.warn("Test config is being used", testConfig);
      }
    }

    // user config will override system default config file
    config = Object.assign({}, defaultConfig, userConfig, testConfig);
  }
  return config;
}

function getSimpleVersion() {
  const hash = r.getLatestCommitHash();
  const version = getConfig() && getConfig().version;
  return `${version}-${hash}`;
}

module.exports = {
  updateUserConfig: updateUserConfig,
  getConfig: getConfig,
  getSimpleVersion: getSimpleVersion,
  getUserConfig: getUserConfig
};
