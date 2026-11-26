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

'use strict'

let chai = require('chai');
let expect = chai.expect;

const stub = require('./stub_exec.js');
const util = require('../../util/util.js');
// load the platform classes first, Platform.js on its own would require them while it is still loading
require('../../plugins/plugin_loader.js');
const OrangePlatform = stub.load(require.resolve('../../platform/orange/OrangePlatform.js'));

const AP = "wlan5g_aaaaaa";
const iwInfo = (channel, freq, width, center1) =>
  `Interface x\n\tifindex 9\n\ttype AP\n\tchannel ${channel} (${freq} MHz), width: ${width} MHz, center1: ${center1} MHz\n`;

describe('Test Orange CAC skip within the STA channel', function(){
  this.timeout(30000);

  const origDelay = util.delay;
  let platform;
  let skipped;

  beforeEach(() => {
    stub.reset();
    util.delay = async () => {};
    platform = new OrangePlatform();
    clearInterval(platform.apStateAutomataTask);
    skipped = 0;
    platform.skipDFSCAC = async () => { skipped++; };
  });
  afterEach(() => {
    util.delay = origDelay;
  });

  it('should skip a CAC on the same 160MHz segment as the STA', async()=> {
    stub.outputFor("hostapd_cli", "state=DFS\nchannel=48\n");
    stub.outputFor(`iw dev ${AP} info`, iwInfo(48, 5240, 160, 5250));
    stub.outputFor("iw dev wlan0 info", iwInfo(48, 5240, 160, 5250));
    await platform.skipCACWithinSTAChannel(AP);
    expect(skipped).to.equal(1);
  });

  it('should skip a CAC on a segment inside the STA segment', async()=> {
    stub.outputFor("hostapd_cli", "state=DFS\n");
    stub.outputFor(`iw dev ${AP} info`, iwInfo(52, 5260, 80, 5290));
    stub.outputFor("iw dev wlan0 info", iwInfo(48, 5240, 160, 5250));
    await platform.skipCACWithinSTAChannel(AP);
    expect(skipped).to.equal(1);
  });

  it('should keep a CAC wider than the STA segment', async()=> {
    // AP on 36-64 while the uplink only runs 36-48, radar on 52-64 was never checked by it
    stub.outputFor("hostapd_cli", "state=DFS\n");
    stub.outputFor(`iw dev ${AP} info`, iwInfo(48, 5240, 160, 5250));
    stub.outputFor("iw dev wlan0 info", iwInfo(48, 5240, 80, 5210));
    await platform.skipCACWithinSTAChannel(AP);
    expect(skipped).to.equal(0);
  });

  it('should keep a CAC on another channel than the STA', async()=> {
    stub.outputFor("hostapd_cli", "state=DFS\n");
    stub.outputFor(`iw dev ${AP} info`, iwInfo(100, 5500, 160, 5570));
    stub.outputFor("iw dev wlan0 info", iwInfo(48, 5240, 160, 5250));
    await platform.skipCACWithinSTAChannel(AP);
    expect(skipped).to.equal(0);
  });

  it('should keep a CAC when the STA is not associated', async()=> {
    stub.outputFor("hostapd_cli", "state=DFS\n");
    stub.outputFor(`iw dev ${AP} info`, iwInfo(48, 5240, 160, 5250));
    stub.outputFor("iw dev wlan0 info", "Interface wlan0\n\tifindex 7\n\ttype managed\n");
    await platform.skipCACWithinSTAChannel(AP);
    expect(skipped).to.equal(0);
  });

  it('should keep a CAC when the STA is on 2.4G', async()=> {
    stub.outputFor("hostapd_cli", "state=DFS\n");
    stub.outputFor(`iw dev ${AP} info`, iwInfo(48, 5240, 160, 5250));
    stub.outputFor("iw dev wlan0 info", "\tchannel 6 (2437 MHz), width: 20 MHz (no HT), center1: 2437 MHz\n");
    await platform.skipCACWithinSTAChannel(AP);
    expect(skipped).to.equal(0);
  });

  it('should stop polling once the AP is enabled without a CAC', async()=> {
    stub.outputFor("hostapd_cli", "state=ENABLED\n");
    await platform.skipCACWithinSTAChannel(AP);
    expect(stub.matching("hostapd_cli").length).to.equal(1);
    expect(stub.matching("iw dev").length).to.equal(0);
    expect(skipped).to.equal(0);
  });

  it('should give up after the attempts while hostapd never reaches a CAC', async()=> {
    stub.outputFor("hostapd_cli", "state=COUNTRY_UPDATE\n");
    await platform.skipCACWithinSTAChannel(AP, 3);
    expect(stub.matching("hostapd_cli").length).to.equal(3);
    expect(skipped).to.equal(0);
  });
});
