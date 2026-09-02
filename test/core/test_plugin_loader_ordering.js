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
'use strict';

const chai = require('chai');
const expect = chai.expect;

describe('plugin_loader ordering', function () {
  it('should create a reversed copy without mutating the source ordering', function () {
    const pluginConfs = [
      { category: 'interface', init_seq: 1 },
      { category: 'routing', init_seq: 2 },
      { category: 'nat', init_seq: 3 },
    ];

    const reversedPluginConfs = [...pluginConfs].reverse();

    expect(reversedPluginConfs.map(pluginConf => pluginConf.category))
      .to.deep.equal(['nat', 'routing', 'interface']);
    expect(pluginConfs.map(pluginConf => pluginConf.category))
      .to.deep.equal(['interface', 'routing', 'nat']);
  });
});
