/*    Copyright 2026 Firewalla Inc.
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

// Helper for the plugin tests that assert on the command a plugin would run, rather than running
// it. Not a test file itself.
//
// A plugin captures `exec` when it is first required, so it has to be loaded while the stub is in
// place. Afterwards the real exec is put back and the shared base classes are dropped from the
// cache - otherwise the first plugin test to load would leave a stubbed InterfaceBasePlugin behind
// and test_intf_base.js, which drives real interfaces, would silently stop shelling out.

'use strict'

const path = require('path');
// plugin_loader reads config/config.json from here, resolve it from this checkout so the plugin
// suites also run off-device
process.env.FIREROUTER_HOME = process.env.FIREROUTER_HOME || path.resolve(__dirname, '../..');

const cpp = require('child-process-promise');

const calls = [];

const SHARED = [
  '../../plugins/plugin.js',
  '../../plugins/interface/intf_base_plugin.js',
];

function evict(resolvedPaths) {
  for (const p of resolvedPaths)
    delete require.cache[p];
}

// resolvedPath must come from the caller's own require.resolve, so relative paths stay readable
// in the test files
function load(resolvedPath) {
  const origExec = cpp.exec;
  cpp.exec = (cmd) => {
    calls.push(cmd);
    return Promise.resolve({stdout: "", stderr: ""});
  };
  const shared = SHARED.map(p => require.resolve(p));
  evict([resolvedPath, ...shared]);
  const mod = require(resolvedPath);
  cpp.exec = origExec;
  evict(shared);
  return mod;
}

// build a configured plugin without going through the loader
function build(Klass, name, config) {
  const plugin = new Klass(name);
  plugin.networkConfig = config;
  return plugin;
}

module.exports = {
  load,
  build,
  calls,
  reset: () => { calls.length = 0; },
  matching: (needle) => calls.filter(c => c.includes(needle)),
};
