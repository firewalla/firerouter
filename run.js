'use strict';

const pl = require('./plugins/plugin_loader.js');

const ns = require('./core/network_setup');
const ncm = require('./core/network_config_mgr');
const log = require('./util/logger')(__filename);

(async () => {
  await pl.initPlugins();
  const activeConfig = ( await ncm.getActiveConfig() ) || require('./network/default_4ports');
  await ns.setup(activeConfig);
  log.info("Setup Complete!");
  process.exit(0);
})();

