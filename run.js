'use strict';

const pl = require('./plugins/plugin_loader.js');

const ns = require('./core/network_setup');

(async () => {
  await pl.initPlugins();
  await ns.setup(require('./network/default_4ports'));
})();

