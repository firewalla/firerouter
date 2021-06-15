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

const log = require('../util/logger.js')(__filename);
const config = require('../util/config.js').getConfig();
const Message = require('../core/Message.js');

let pluginConfs = [];

let pluginCategoryMap = {};

let scheduledReapplyTask = null;
let restartRsyslogTask = null;

const _ = require('lodash');
const Promise = require('bluebird');
const AsyncLock = require('async-lock');
const exec = require('child-process-promise').exec;
const fwpclient = require('../util/redis_manager.js').getPublishClient();
const lock = new AsyncLock();
const LOCK_REAPPLY = "LOCK_REAPPLY";
let applyInProgress = false;

async function initPlugins() {
  if(_.isEmpty(config.plugins)) {
    return;
  }

  pluginConfs = config.plugins.sort((a, b) => {
    return a.init_seq - b.init_seq
  });

  for (let pluginConf of pluginConfs) {
    try {
      const filePath = pluginConf.file_path;
      if (!pluginCategoryMap[pluginConf.category])
        pluginCategoryMap[pluginConf.category] = {};
      const pluginClass = require(filePath);
      pluginConf.c = pluginClass;
      await pluginClass.preparePlugin().catch((err) => {
        log.error(`Failed to prepare plugin ${pluginClass.name}`, err);
      });
    } catch (err) {
      log.error("Failed to initialize plugin ", pluginConf, err);
    }
  }

  log.info("Plugin initialized", pluginConfs);
}

function createPluginInstance(category, name, constructor) {
  let instance = pluginCategoryMap[category] && pluginCategoryMap[category][name];
  if (instance)
    return instance;

  if (!pluginCategoryMap[category])
    pluginCategoryMap[category] = {};

  if (!constructor)
    return null;

  instance = new constructor(name);
  instance.name = name;
  pluginCategoryMap[category][name] = instance;
  log.info("Instance created", instance);
  return instance;
}

function getPluginInstances(category) {
  return pluginCategoryMap[category];
}

function getPluginInstance(category, name) {
  return pluginCategoryMap[category] && pluginCategoryMap[category][name];
}

function _isConfigEqual(c1, c2) {
  if (!c1 || !c2)
    return false;
  const c1Copy = JSON.parse(JSON.stringify(c1));
  const c2Copy = JSON.parse(JSON.stringify(c2));

  // ignore name change
  if (c1Copy.meta && c1Copy.meta.name)
    delete c1Copy.meta["name"];
  if (c2Copy.meta && c2Copy.meta.name)
    delete c2Copy.meta["name"];

  // ignore extra data
  if (c1Copy.hasOwnProperty("extra"))
    delete c1Copy["extra"];
  if (c2Copy.hasOwnProperty("extra"))
    delete c2Copy["extra"];

  return _.isEqual(c1Copy, c2Copy);
}

async function _publishChangeApplied() {
  // publish to redis db used by Firewalla
  await fwpclient.publishAsync(Message.MSG_FR_CHANGE_APPLIED, "");
}

async function _publishIfaceChangeApplied() {
  // publish to redis db used by Firewalla
  await fwpclient.publishAsync(Message.MSG_FR_IFACE_CHANGE_APPLIED, "");
}

function isApplyInProgress() {
  return applyInProgress;
}

async function reapply(config, dryRun = false) {
  return new Promise((resolve, reject) => {
    lock.acquire(LOCK_REAPPLY, async function(done) {
      applyInProgress = true;
      const errors = [];
      let newPluginCategoryMap = {};
      let changeApplied = false;
      let ifaceChangeApplied = false;
      const reversedPluginConfs = pluginConfs.reverse();
      // if config is not set, simply reapply effective config
      if (config) {
        // remove plugins in descending order by init sequence
        for (let pluginConf of reversedPluginConfs) {
          newPluginCategoryMap[pluginConf.category] = newPluginCategoryMap[pluginConf.category] || {};
          if (!pluginConf.c)
            continue;
          const instances = Object.values(pluginCategoryMap[pluginConf.category]).filter(i => i.constructor.name === pluginConf.c.name);
          if (instances) {
            for (let instance of instances) {
              instance._mark = 0;
            }
          } else pluginCategoryMap[pluginConf.category] = {};
    
          const newInstances = {};
          const keys = pluginConf.config_path.split(".");
          let value = config;
          for (let key of keys) {
            if (value)
              value = value[key];
          }
          if (value) {
            for (let name in value) {
              const instance = createPluginInstance(pluginConf.category, name, pluginConf.c);
              if (!instance)
                continue;
              instance._mark = 1;
              const oldConfig = instance.networkConfig;
              if (oldConfig && !_isConfigEqual(oldConfig, value[name])) {
                log.info(`Network config of ${pluginConf.category}-->${name} changed`, oldConfig, value[name]);
                instance.propagateConfigChanged(true);
              }
              instance._nextConfig = value[name];
              if (!oldConfig) {
                // initialization of network config, flush instance with new config
                log.info(`Initial setup of ${pluginConf.category}-->${name}`, value[name]);
                instance.propagateConfigChanged(true);
                instance.unsubscribeAllChanges();
              }
              newInstances[name] = instance;
            }
          }
    
          if (instances) {
            const removedInstances = instances.filter(i => i._mark == 0);
            for (let instance of removedInstances) {
              if (!dryRun) {
                log.info(`Removing plugin ${pluginConf.category}-->${instance.name} ...`);
                await instance.flush();
                changeApplied = true;
                if (pluginConf.category === "interface")
                  ifaceChangeApplied = true;
              }
              instance.propagateConfigChanged(true);
              instance.unsubscribeAllChanges();
            }
          }
          // merge with new pluginCategoryMap
          newPluginCategoryMap[pluginConf.category] = Object.assign({}, newPluginCategoryMap[pluginConf.category], newInstances);
        }
      } else {
        newPluginCategoryMap = pluginCategoryMap;
      }
    
      // flush all changed plugins in descending order by init sequence
      for (let pluginConf of reversedPluginConfs) {
        const instances = Object.values(newPluginCategoryMap[pluginConf.category]).filter(i => i.constructor.name === pluginConf.c.name);
        if (instances) {
          for (let instance of instances) {
            if (!instance.networkConfig) // newly created instance
              instance.configure(instance._nextConfig);
            if (instance.isReapplyNeeded()) {
              if (!dryRun) {
                log.info("Flushing old config", pluginConf.category, instance.name);
                await instance.flush();
                changeApplied = true;
                if (pluginConf.category === "interface")
                  ifaceChangeApplied = true;
              }
              instance.unsubscribeAllChanges();
            }
            if (config) {
              // do not change config if config is not set
              instance.configure(instance._nextConfig);
            }
          }
        }
      }
    
      // apply plugin configs in ascending order by init sequence
      pluginConfs = reversedPluginConfs.reverse();
      // do not apply config in dry run
      if (dryRun) {
        applyInProgress = false;
        done(null, errors);
        return;
      }
      for (let pluginConf of pluginConfs) {
        const instances = Object.values(newPluginCategoryMap[pluginConf.category]).filter(i => i.constructor.name === pluginConf.c.name);
        if (instances) {
          for (let instance of instances) {
            if (instance.isReapplyNeeded()) {
              log.info("Applying new config", pluginConf.category, instance.name);
              await instance.apply().catch((err) => {
                log.error(`Failed to apply config of ${pluginConf.category}-->${instance.name}`, instance.networkConfig, err);
                errors.push(err.message || err);
              });
              changeApplied = true;
              if (pluginConf.category === "interface")
                  ifaceChangeApplied = true;
            } else {
              log.info("Instance config is not changed. No need to apply config", pluginConf.category, instance.name);
            }
            instance.propagateConfigChanged(false);
          }
        }
      }
      pluginCategoryMap = newPluginCategoryMap;
      if (changeApplied)
        await _publishChangeApplied();
      if (ifaceChangeApplied)
        await _publishIfaceChangeApplied();
      applyInProgress = false;
      done(null, errors);
      return;
    }, function(err, ret) {
      applyInProgress = false;
      if (err)
        reject(err);
      else
        resolve(ret);
    });
  });
}

function scheduleReapply() {
  if (!scheduledReapplyTask) {
    scheduledReapplyTask = setTimeout(() => {
      reapply(null, false);
    }, 10000);
  } else {
    scheduledReapplyTask.refresh();
  }
}

function scheduleRestartRsyslog() {
  if (restartRsyslogTask)
    clearTimeout(restartRsyslogTask);
  restartRsyslogTask = setTimeout(() => {
    exec(`sudo systemctl restart rsyslog`).catch((err) => {
      log.error("Failed to restart rsyslog", err.message);
    });
  }, 5000);
}

module.exports = {
  initPlugins:initPlugins,
  getPluginInstance: getPluginInstance,
  getPluginInstances: getPluginInstances,
  reapply: reapply,
  scheduleReapply: scheduleReapply,
  scheduleRestartRsyslog: scheduleRestartRsyslog,
  isApplyInProgress: isApplyInProgress
};
