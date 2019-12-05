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

const pl = require('./plugins/plugin_loader.js');

const ns = require('./core/network_setup');
const ncm = require('./core/network_config_mgr');
const log = require('./util/logger')(__filename);

(async () => {
  await pl.initPlugins();
  const activeConfig = ( await ncm.getActiveConfig() ) || (await ncm.getDefaultConfig());
  await ns.prepareEnvironment();
  await ncm.tryApplyConfig(activeConfig);
  await ncm.saveConfig(activeConfig);
  log.info("Setup Complete!");
  setTimeout(() => {
    process.exit(0);
  }, 10000);
})();

