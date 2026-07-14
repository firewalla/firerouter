/*    Copyright 2016-2024 Firewalla Inc.
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

'use strict'

let chai = require('chai');
let expect = chai.expect;

let util = require('../../util/util.js');
let log = require('../../util/logger.js')(__filename, 'info');

describe('Test util', function(){
  this.timeout(30000);

  before((done) => (
    async() => {
        done();
    })()
  );

  after((done) => (
    async() => {
        done();
    })()
  );


  it('should generate uuid', async()=> {
    const u = util.generateUUID();
    log.debug("generate uuid", u);
    expect(u.length).to.be.equal(32);
  });


});
