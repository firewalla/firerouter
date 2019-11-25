/*    Copyright 2016 Firewalla LLC
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

const log = require('../util/logger.js')(__filename);
const config = require('../util/config.js').getConfig();

const plugins = [];
const pluginsHash = {};

const _ = require('lodash');

const Promise = require('bluebird');

function initSinglePlugin(name, path, config) {
  try {
    const s = require(path);
    const ss = new s();
    ss.name = name;
    ss.init(config);
    plugins.push(ss);
    pluginsHash[name] = ss;
    return ss;
  } catch(err) {
    log.error(`Failed to load plugin: ${name}: ${err}`);
    return null
  }
}

async function initPlugins() {
  if(_.isEmpty(config.plugins)) {
    return;
  }

  const plugins = await findEnabledPlugins();
  const configuredPluginNames = Object.keys(config.plugins);

  configuredPluginNames.forEach((pluginName) => {
    if(!plugins[pluginName]) {
      return;
    }

    initSinglePlugin(pluginName, plugins[pluginName].path, config.plugins[pluginName]);
  });
}

async function run(config) {
  for(const plugin of plugins) {
    log.info("Configuring network with plugin:", plugin.name);
    try {
      await pluginsHash[plugin.name].run(config);
    } catch(err) {
      log.error(`Failed to configure network with plugin: ${plugin.name}, err: ${err}`)
    }
  }
}

function getPlugin(name) {
  return pluginsHash[name]
}

async function findPluginFiles() {
  const glob = require('glob');

  return new Promise((resolve, reject) => {
    glob(__dirname + '/**/*_plugin.js', {}, (err, files)=>{
      resolve(files);
    })
  });
}

async function findEnabledPlugins() {
  const files = await findPluginFiles();
  if(_.isEmpty(config.plugins)) {
    return {};
  }

  const plugins = {};

  files.forEach((file) => {
    const basename = file.replace(/.*\//, "").replace(/\.js$/, "");
    const relativePath = file.replace(__dirname, ".");
    plugins[basename] = {
      path: relativePath
    }
  });

  return plugins;
}

module.exports = {
  initPlugins:initPlugins,
  initSinglePlugin:initSinglePlugin,
  run:run,
  getPlugin: getPlugin
};
