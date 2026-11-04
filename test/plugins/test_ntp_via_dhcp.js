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
const r = require('../../util/firerouter');
const pl = require('../../platform/PlatformLoader.js');
// load the platform classes first, Platform.js on its own would require them while it is still loading
require('../../plugins/plugin_loader.js');
const Platform = require('../../platform/Platform.js');
const CrystalPlatform = require('../../platform/crystal/CrystalPlatform.js');

const HOOKS_DIR = "/etc/dhcp/dhclient-exit-hooks.d";

// ntp_via_dhcp captures the platform at load, so load a copy with the given one in place
function loadWith(platform) {
  const orig = pl.platform;
  pl.platform = platform;
  try {
    return stub.load(require.resolve('../../plugins/dhcp/ntp_via_dhcp.js'));
  } finally {
    pl.platform = orig;
  }
}

describe('Test NTP via DHCP hook install', function(){
  this.timeout(30000);

  beforeEach(() => {
    stub.reset();
  });

  it('should install the chrony hook on crystal', async()=> {
    await loadWith(new CrystalPlatform()).installHook();
    expect(stub.calls).to.eql([
      `sudo rm -f ${HOOKS_DIR}/ntp ${HOOKS_DIR}/ntpdate ${HOOKS_DIR}/timesyncd`,
      `sudo cp ${r.getFireRouterHome()}/scripts/dhclient_hooks/chrony ${HOOKS_DIR}/chrony`,
    ]);
  });

  it('should install the ntp hook on the default platform', async()=> {
    await loadWith(new Platform()).installHook();
    expect(stub.calls).to.eql([
      `sudo rm -f ${HOOKS_DIR}/ntpdate ${HOOKS_DIR}/timesyncd ${HOOKS_DIR}/chrony`,
      `sudo cp ${r.getFireRouterHome()}/scripts/dhclient_hooks/ntp ${HOOKS_DIR}/ntp`,
    ]);
  });
});
