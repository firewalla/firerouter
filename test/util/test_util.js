/*    Copyright 2016-2026 Firewalla Inc.
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

const uuid = require('uuid');
let util = require('../../util/util.js');
let log = require('../../util/logger.js')(__filename, 'info');

describe('Test util', function(){
  this.timeout(30000);

  before(async () => {
  });

  after(async () => {
  });


  it('should generate uuid', async()=> {
    const u = util.generateUUID();
    log.debug("generate uuid", u);
    expect(u.length).to.be.equal(32);
  });

  describe('getHexStrArray', function(){
    // callers join the array with no separator, so a byte that renders as one digit
    // desynchronizes every byte after it
    it('should emit two digits for every byte', async()=> {
      for (const str of ["MyWiFi", "café", "a\nb", "", "Guest WiFi"]) {
        const arr = util.getHexStrArray(str);
        const bytes = Buffer.from(str, 'utf8').length;
        expect(arr.length, `byte count of ${JSON.stringify(str)}`).to.be.equal(bytes);
        for (const hex of arr)
          expect(hex.length, `width of ${hex} in ${JSON.stringify(str)}`).to.be.equal(2);
      }
    });

    it('should round trip through a joined hex string', async()=> {
      for (const str of ["MyWiFi", "café", "a\nb", ""]) {
        const joined = util.getHexStrArray(str).join("");
        log.debug("hex of", JSON.stringify(str), joined);
        expect(Buffer.from(joined, 'hex').toString('utf8')).to.be.equal(str);
      }
    });

    it('should pad a control character rather than shortening it', async()=> {
      // 0x0a used to render as "a", shifting the decoding of everything after it
      expect(util.getHexStrArray("a\nb").join("")).to.be.equal("610a62");
    });
  });

  describe('isValidUUID', function(){
    it('should accept canonical uuids', async()=> {
      expect(util.isValidUUID(uuid.v4())).to.be.true;
      expect(util.isValidUUID("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).to.be.true;
    });

    it('should reject a malformed uuid', async()=> {
      expect(util.isValidUUID("x; sudo id > /tmp/pwn; #")).to.be.false;
      expect(util.isValidUUID("")).to.be.false;
      // generateUUID produces a dashless 32 char id, which is not a uuid and is used elsewhere
      expect(util.isValidUUID("0123456789abcdef0123456789abcdef")).to.be.false;
    });

    it('should return false rather than throw on a non string', async()=> {
      // validator.isUUID throws on non strings, callers pass whatever arrived in the config
      for (const input of [null, undefined, 12345, {}, []])
        expect(util.isValidUUID(input), `input ${JSON.stringify(input)}`).to.be.false;
    });
  });

  describe('toBoundedInt', function(){
    it('should accept an in-range integer as a number or a string', async()=> {
      // the same config value arrives typed differently depending on which producer wrote it
      expect(util.toBoundedInt(51820, 1, 65535)).to.be.equal(51820);
      expect(util.toBoundedInt("51820", 1, 65535)).to.be.equal(51820);
      expect(util.toBoundedInt(" 51820 ", 1, 65535)).to.be.equal(51820);
      expect(util.toBoundedInt(1, 1, 65535)).to.be.equal(1);
      expect(util.toBoundedInt(65535, 1, 65535)).to.be.equal(65535);
    });

    it('should reject values outside the bounds', async()=> {
      expect(util.toBoundedInt(0, 1, 65535)).to.be.null;
      expect(util.toBoundedInt(65536, 1, 65535)).to.be.null;
      expect(util.toBoundedInt(-1, 1, 65535)).to.be.null;
      expect(util.toBoundedInt("70000", 1, 65535)).to.be.null;
    });

    it('should reject anything that is not a whole number', async()=> {
      // a bare Number() would let all of these through
      expect(util.toBoundedInt(1.5, 1, 65535)).to.be.null;
      expect(util.toBoundedInt("Infinity", 1)).to.be.null;
      expect(util.toBoundedInt(Infinity, 1)).to.be.null;
      expect(util.toBoundedInt(NaN, 1)).to.be.null;
      expect(util.toBoundedInt("x; touch /tmp/pwn; #", 1, 65535)).to.be.null;
    });

    it('should reject empty and non scalar input rather than coercing it', async()=> {
      // "" and [] both coerce to 0, true coerces to 1, none of them are a config value
      for (const input of ["", "   ", null, undefined, true, false, {}, [], [5]])
        expect(util.toBoundedInt(input, 1, 65535), `input ${JSON.stringify(input)}`).to.be.null;
    });

    it('should default the bounds when they are omitted', async()=> {
      expect(util.toBoundedInt("42")).to.be.equal(42);
      expect(util.toBoundedInt(-42)).to.be.equal(-42);
      // a lower bound alone is enough for the positive-integer cases
      expect(util.toBoundedInt(-42, 1)).to.be.null;
      expect(util.toBoundedInt("2048", 1)).to.be.equal(2048);
    });
  });

  describe('lastLine', function(){
    it('should behave like tail -n 1', async()=> {
      expect(util.lastLine("2606:4700::1111\n1.1.1.1\n")).to.be.equal("1.1.1.1");
      expect(util.lastLine("1.1.1.1")).to.be.equal("1.1.1.1");
      expect(util.lastLine("  a  \n  b  \n")).to.be.equal("b");
    });

    it('should tolerate empty output', async()=> {
      expect(util.lastLine("")).to.be.equal("");
      expect(util.lastLine(null)).to.be.equal("");
      expect(util.lastLine(undefined)).to.be.equal("");
    });
  });

});
