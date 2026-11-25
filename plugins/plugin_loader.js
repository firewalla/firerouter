/*    Copyright 2019-2022 Firewalla Inc.
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

const Plugin = require('./plugin.js');
const log = require('../util/logger.js')(__filename);
const config = require('../util/config.js').getConfig();
const Message = require('../core/Message.js');

let pluginConfs = [];

let pluginCategoryMap = {};

let scheduledReapplyTask = null;
let restartRsyslogTask = null;

const _ = require('lodash');
const AsyncLock = require('async-lock');
const { execFile } = require('child-process-promise');
const fwpclient = require('../util/redis_manager.js').getPublishClient();
// get the platform on use: platform modules require this module, so loading one here hands them an empty exports
const platformLoader = require('../platform/PlatformLoader.js');
const lock = new AsyncLock();
const LOCK_REAPPLY = "LOCK_REAPPLY";
let applyInProgress = false;
let lastAppliedTimestamp = null;

let CHANGE_FLAGS = 0;
const FLAG_IFACE_CHANGE = 0x1;
const FLAG_CHANGE = 0x2;
const FLAG_APC_CHANGE = 0x4;

async function initPlugins() {
  if (_.isEmpty(config.plugins)) {
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
  await execFile("sudo", ["systemctl", "daemon-reload"]).catch((err) => {
    log.error(`Failed to reload systemctl daemon`, err.message);
  });

  log.info("Plugin initialized", pluginConfs);
}

function createPluginInstance(category, name, constructor, config = null) {
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
  if (config) {
    instance.init(config);
  }
  log.info("Instance created", instance.name);
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
  if (!_.has(c1Copy, ["meta", "type"]) && !_.has(c2Copy, ["meta", "type"])) {
    // ignore meta if both configs have no type, i.e., different uuids in interface configs are treated as the same config in this case
    delete c1Copy.meta;
    delete c2Copy.meta;
  }

  return _.isEqual(c1Copy, c2Copy);
}

async function publishChangeApplied() {
  // publish to redis db used by Firewalla
  if (!isApplyInProgress())
    await fwpclient.publishAsync(Message.MSG_FR_CHANGE_APPLIED, "");
  else
    CHANGE_FLAGS |= FLAG_CHANGE;
}

async function publishIfaceChangeApplied() {
  // publish to redis db used by Firewalla
  if (!isApplyInProgress())
    await fwpclient.publishAsync(Message.MSG_FR_IFACE_CHANGE_APPLIED, "");
  else
    CHANGE_FLAGS |= FLAG_IFACE_CHANGE;
}

async function publishAPCChangeApplied() {
  if (!isApplyInProgress())
    await fwpclient.publishAsync(Message.MSG_FR_APC_CHANGE_APPLIED, "");
  else
    CHANGE_FLAGS |= FLAG_APC_CHANGE;
}

function isApplyInProgress() {
  return applyInProgress;
}

function getLastAppliedTimestamp() {
  return lastAppliedTimestamp;
}

async function acquireApplyLock(func) {
  return lock.acquire(LOCK_REAPPLY, async () => {
    await func()
  }).catch((err) => {
    log.error(`Failed to run async function with apply lock`, err.message);
  });
}

function markChanged(category) {
  if (category === "apc") {
    CHANGE_FLAGS |= FLAG_APC_CHANGE;
  } else {
    CHANGE_FLAGS |= FLAG_CHANGE;
    if (category === "interface")
      CHANGE_FLAGS |= FLAG_IFACE_CHANGE;
  }
}

// flush an instance marked for reapply, then configure it with _nextConfig unless keepConfig is set
async function flushInstance(instance, pluginConf, dryRun, keepConfig) {
  if (!instance.networkConfig) // newly created instance
    instance.configure(instance._nextConfig);
  if (instance.isReapplyNeeded()) {
    if (!dryRun) {
      if (instance.isFlushNeeded(instance._nextConfig)) {
        if (instance.isFullFlushNeeded(instance._nextConfig)) {
          log.info("Flushing old config", pluginConf.category, instance.name);
          await instance.flush();
        } else {
          log.info("Fast flushing old config", pluginConf.category, instance.name);
          await instance.flushFast();
        }
      } else
        log.info("No need to flush old config", pluginConf.category, instance.name);
      markChanged(pluginConf.category);
    }
    instance.unsubscribeAllChanges();
  }
  if (!keepConfig) {
    instance.configure(instance._nextConfig);
  }
}

// apply an instance marked for reapply, errors collects the failure if any
async function applyInstance(instance, pluginConf, errors) {
  if (instance.isReapplyNeeded()) {
    log.info("Applying new config", pluginConf.category, instance.name);
    await instance.apply().catch((err) => {
      log.error(`Failed to apply config of ${pluginConf.category}-->${instance.name}`, instance.networkConfig, err);
      errors.push(err.message || err);
    });
    markChanged(pluginConf.category);
  } else {
    log.info("Instance config is not changed. No need to apply config", pluginConf.category, instance.name);
  }
  instance.propagateConfigChanged(Plugin.CHANGE_NONE);
}

// to be called after applyInProgress is cleared, so that the publish functions send to redis immediately
async function publishChangeFlags() {
  if (CHANGE_FLAGS & FLAG_CHANGE)
    await publishChangeApplied();
  if (CHANGE_FLAGS & FLAG_IFACE_CHANGE)
    await publishIfaceChangeApplied();
  if (CHANGE_FLAGS & FLAG_APC_CHANGE)
    await publishAPCChangeApplied();
  CHANGE_FLAGS = 0;
}

async function reapply(config, dryRun = false) {
  let t1, t2;
  return await lock.acquire(LOCK_REAPPLY, async () => {
   try {
    t1 = Date.now() / 1000;
    applyInProgress = true;
    const errors = [];

    const country = _.get(config, ['apc', 'globalSysConfig', 'country']);
    const wlanReloaded = await platformLoader.getPlatform().prepareWLANRegDomainChange(country).catch((err) => {
      log.error(`Failed to prepare WLAN reg domain change for country ${country}`, err);
      errors.push(err.message || err);
      return false;
    });

    let newPluginCategoryMap = {};
    const reversedPluginConfs = pluginConfs.reverse();
    // if config is not set, simply reapply effective config
    if (config) {
      // remove plugins in descending order by init sequence
      const remove = async (instance, pluginConf) => {
        if (!dryRun) {
          log.info(`Removing plugin ${pluginConf.category}-->${instance.name} ...`);
          await instance.flush();
          markChanged(pluginConf.category);
        }
        instance.propagateConfigChanged(Plugin.CHANGE_FULL);
        instance.unsubscribeAllChanges();
        pluginCategoryMap && pluginCategoryMap[pluginConf.category] && delete pluginCategoryMap[pluginConf.category][instance.name];
      };
      for (let pluginConf of reversedPluginConfs) {
        const concurrent = pluginConf.allow_concurrent;
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
            const instance = createPluginInstance(pluginConf.category, name, pluginConf.c, pluginConf.config);
            if (!instance)
              continue;
            instance._mark = 1;
            const oldConfig = instance.networkConfig;
            if (oldConfig && !_isConfigEqual(oldConfig, value[name])) {
              log.info(`Network config of ${pluginConf.category}-->${name} changed`, pluginConf.hide_config_in_log ? "hidden" : oldConfig, pluginConf.hide_config_in_log ? "hidden" : value[name]);
              const changeType = instance.getConfigChangeType(value[name]);
              instance.propagateConfigChanged(changeType);
            }
            instance._nextConfig = value[name];
            if (!oldConfig) {
              // initialization of network config, flush instance with new config
              log.info(`Initial setup of ${pluginConf.category}-->${name}`, pluginConf.hide_config_in_log ? "hidden" : value[name]);
              instance.propagateConfigChanged(Plugin.CHANGE_FULL);
              instance.unsubscribeAllChanges();
            }
            if (wlanReloaded && pluginConf.config_path === "interface.wlan") {
              instance.propagateConfigChanged(Plugin.CHANGE_FULL);
            }
            newInstances[name] = instance;
          }
        }

        if (instances) {
          const removedInstances = instances.filter(i => i._mark == 0);
          const promises = [];
          for (let instance of removedInstances) {
            if (concurrent) {
              promises.push(remove(instance, pluginConf));
            } else {
              await remove(instance, pluginConf);
            }
          }
          if (concurrent && !_.isEmpty(promises)) {
            if (!dryRun)
              log.info(`Removing ${removedInstances.length} instances of ${pluginConf.category} in concurrent mode`);
            await Promise.all(promises);
          }
        }
        // merge with new pluginCategoryMap
        newPluginCategoryMap[pluginConf.category] = Object.assign({}, newPluginCategoryMap[pluginConf.category], newInstances);
      }
    } else {
      newPluginCategoryMap = pluginCategoryMap;
    }

    // do not change config if config is not set
    const flush = (instance, pluginConf) => flushInstance(instance, pluginConf, dryRun, !config);

    // flush all changed plugins in descending order by init sequence
    for (let pluginConf of reversedPluginConfs) {
      const instances = Object.values(newPluginCategoryMap[pluginConf.category]).filter(i => i.constructor.name === pluginConf.c.name);
      const concurrent = pluginConf.allow_concurrent;
      if (instances) {
        const promises = [];
        for (let instance of instances) {
          if (concurrent) {
            promises.push(flush(instance, pluginConf));
          } else {
            await flush(instance, pluginConf);
          }
        }
        if (concurrent && !_.isEmpty(promises)) {
          if (!dryRun)
            log.info(`Flushing instances of ${pluginConf.category} in concurrent mode`);
          await Promise.all(promises);
        }
      }
    }

    // apply plugin configs in ascending order by init sequence
    pluginConfs = reversedPluginConfs.reverse();
    // do not apply config in dry run
    if (dryRun) {
      applyInProgress = false;
      lastAppliedTimestamp = Date.now() / 1000;
      return errors;
    }
    const apply = (instance, pluginConf) => applyInstance(instance, pluginConf, errors);
    for (let pluginConf of pluginConfs) {
      const concurrent = pluginConf.allow_concurrent;
      const instances = Object.values(newPluginCategoryMap[pluginConf.category]).filter(i => i.constructor.name === pluginConf.c.name);
      if (instances) {
        const promises = [];
        for (let instance of instances) {
          if (concurrent) {
            promises.push(apply(instance, pluginConf));
          } else {
            await apply(instance, pluginConf);
          }
        }
        if (concurrent && !_.isEmpty(promises)) {
          log.info(`Applying instances of ${pluginConf.category} in concurrent mode`);
          await Promise.all(promises);
        }
      }
    }
    pluginCategoryMap = newPluginCategoryMap;
    // before applyInProgress is cleared, so that one of them always shows this apply while the publish below is awaited
    lastAppliedTimestamp = Date.now() / 1000;
    applyInProgress = false;
    // clear applyInProgress so that subsequent publish functions will send message to redis immediately
    await publishChangeFlags();
    lastAppliedTimestamp = Date.now() / 1000;
    return errors;
   } finally {
    // cleared before the lock is released, the next holder may already have set it when the handlers below run
    applyInProgress = false;
   }
  }).then((errors) => {
    lastAppliedTimestamp = Date.now() / 1000;
    t2 = Date.now() / 1000;
    log.info(`reapply is complete ${_.isEmpty(errors) ? "without" : "with"} error, elapsed time: ${(t2 - t1).toFixed(3)}`);
    return errors;
  }).catch((err) => {
    log.error(`Failed to apply network config`, err);
    return [err.message];
  });
}

// apply new configs to existing instances of one category the way reapply does, without a full reapply. Every plugin that
// subscribes to a changed instance is flushed and applied with it, the rest are left alone. An instance that fails to apply
// stays marked, so the next reapply retries it although its config did not change. Returns the errors, or null if configs
// names an instance that does not exist
async function reapplyInstances(category, configs) {
  return lock.acquire(LOCK_REAPPLY, async () => {
    const t1 = Date.now() / 1000;
    const existing = pluginCategoryMap[category] || {};
    if (Object.keys(configs).some(name => !existing[name]))
      return null;
    applyInProgress = true;
    const errors = [];
    try {
      const affected = new Set();
      for (const name of Object.keys(configs)) {
        const instance = existing[name];
        if (_isConfigEqual(instance.networkConfig, configs[name]))
          continue;
        log.info(`Network config of ${category}-->${name} changed`);
        instance.propagateConfigChanged(instance.getConfigChangeType(configs[name]));
        instance._nextConfig = configs[name];
        affected.add(instance);
        for (const subscriber of instance.getRecursiveSubscriberPlugins()) {
          if (affected.has(subscriber))
            continue;
          subscriber._nextConfig = subscriber.networkConfig;
          affected.add(subscriber);
        }
      }
      const ordered = (confs) => confs.map(pluginConf => [pluginConf, [...affected].filter(instance =>
        (pluginCategoryMap[pluginConf.category] || {})[instance.name] === instance && instance.constructor.name === pluginConf.c.name)]);
      for (const [pluginConf, instances] of ordered([...pluginConfs].reverse()))
        for (const instance of instances)
          await flushInstance(instance, pluginConf, false, false);
      const failed = [];
      for (const [pluginConf, instances] of ordered(pluginConfs)) {
        for (const instance of instances) {
          const count = errors.length;
          await applyInstance(instance, pluginConf, errors);
          if (errors.length > count)
            failed.push(instance);
        }
      }
      for (const instance of failed)
        instance.propagateConfigChanged(Plugin.CHANGE_FULL);
    } finally {
      applyInProgress = false;
    }
    await publishChangeFlags();
    lastAppliedTimestamp = Date.now() / 1000;
    log.info(`reapply of ${category} instances is complete ${_.isEmpty(errors) ? "without" : "with"} error, elapsed time: ${(lastAppliedTimestamp - t1).toFixed(3)}`);
    return errors;
  });
}

function scheduleReapply() {
  if (!scheduledReapplyTask) {
    scheduledReapplyTask = setTimeout(() => {
      reapply(null, false);
    }, 4000);
  } else {
    scheduledReapplyTask.refresh();
  }
}

function scheduleRestartRsyslog() {
  if (restartRsyslogTask)
    clearTimeout(restartRsyslogTask);
  restartRsyslogTask = setTimeout(() => {
    execFile("sudo", ["systemctl", "restart", "rsyslog"]).catch((err) => {
      log.error("Failed to restart rsyslog", err.message);
    });
  }, 5000);
}

module.exports = {
  initPlugins: initPlugins,
  getPluginInstance: getPluginInstance,
  getPluginInstances: getPluginInstances,
  acquireApplyLock: acquireApplyLock,
  reapply: reapply,
  reapplyInstances: reapplyInstances,
  scheduleReapply: scheduleReapply,
  scheduleRestartRsyslog: scheduleRestartRsyslog,
  isApplyInProgress: isApplyInProgress,
  getLastAppliedTimestamp: getLastAppliedTimestamp,
  publishChangeApplied: publishChangeApplied,
  publishIfaceChangeApplied: publishIfaceChangeApplied
};
