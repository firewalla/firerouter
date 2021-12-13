/*    Copyright 2021 Firewalla Inc.
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

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const Platform = require('../Platform.js');

const firestatusBaseURL = "http://127.0.0.1:9966";
const exec = require('child-process-promise').exec;
const log = require('../../util/logger.js')(__filename);
const util = require('../../util/util.js');

class PurplePlatform extends Platform {
  getName() {
    return "purple";
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/files/default_setup.json`;
  }

  async getWlanVendor() {
    if ( !this.vendor ) {
      try {
        const procCmdline = await fs.readFileAsync("/proc/cmdline", {encoding: 'utf8'});
        this.vendor = procCmdline.match(' wifi_rev=([0-9a-z]*) ')[1];
      } catch(err) {
        log.error("Failed to parse wifi_rev from /proc/cmdline", err.message);
        return "unknown";
      }
    }
    return this.vendor;
  }

  getWpaCliBinPath() {
    return `${__dirname}/bin/wpa_cli`;
  }

  getWpaPassphraseBinPath() {
    return `${__dirname}/bin/wpa_passphrase`;
  }

  async ledNormalVisibleStart() {
    await exec(`curl -s '${firestatusBaseURL}/fire?name=firerouter&type=normal_visible'`).catch( (err) => {
      log.error("Failed to set LED as WAN normal visible");
    });
  }

  async ledNormalVisibleStop() {
    await exec(`curl -s '${firestatusBaseURL}/resolve?name=firerouter&type=normal_visible'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAllNetworkDown() {
    await exec(`curl -s '${firestatusBaseURL}/fire?name=firerouter&type=network_down'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async ledAnyNetworkUp() {
    await exec(`curl -s '${firestatusBaseURL}/resolve?name=firerouter&type=network_down'`).catch( (err) => {
      log.error("Failed to set LED as WAN NOT normal visible");
    });
  }

  async overrideEthernetKernelModule() {
    const changed = await this.overrideKernelModule(
      'r8168',
      this.getBinaryPath(),
      '/lib/modules/4.9.241-firewalla/kernel/drivers/net/ethernet/realtek/r8168');
    if (changed) {
      // restore MAC address of eth1 from eprom
      const mac = await this.getMac(1); // 1 of 0-3

      if (mac) {
        await exec(`sudo ip link set eth1 address ${mac}`).catch((err) => {
          log.error(`Failed to set MAC address of eth1`, err.message);
        })
      }
    }
  }

  async configEthernet() {
    await this.setEthernetOffload("eth1","sg","scatter-gather","on");
    await this.setEthernetOffload("eth1","tso","TCP segmentation offload","on");
    await this.setEthernetOffload("eth1","gso","generic segmentation offload","on");
  }

  getWifiClientInterface() {
    return "wlan0";
  }

  getWifiAPInterface() {
    return "wlan1";
  }

  async overrideWLANKernelModule() {
    if (await this.getWlanVendor() == '88x2cs') {
      const changed = await this.overrideKernelModule(
        '88x2cs',
        this.getBinaryPath(),
        '/lib/modules/4.9.241-firewalla/kernel/drivers/net/wireless/realtek/rtl8822cs');

      if (changed) {
        // restore MAC address of wlan0 from eprom
        const clientMac = await this.getMac(2); // 2 of 0-3
        const apMac = await this.getMac(3); // 3 of 0-3

        if (clientMac && apMac) {
          const client = this.getWifiClientInterface();
          const ap = this.getWifiAPInterface();

          // shutdown dependant services
          await exec(`sudo systemctl stop firerouter_wpa_supplicant@${client}`).catch((err) => {})
          await exec(`sudo systemctl stop firerouter_hostapd@${ap}`).catch((err) => {})

          // a hard code 1-second wait for system to release wifi interfaces
          await util.delay(1000);

          // force shutdown interfaces
          await exec(`sudo ip link set ${client} down`).catch((err) => {
            log.error(`Failed to turn off interface ${client}`, err.message);
          });

          await exec(`sudo ip link set ${ap} down`).catch((err) => {
            log.error(`Failed to turn off interface ${ap}`, err.message);
          });

          // set mac address
          await exec(`sudo ip link set ${client} address ${clientMac}`).catch((err) => {
            log.error(`Failed to set MAC address of ${client}`, err.message);
          });

          await exec(`sudo ip link set ${ap} address ${apMac}`).catch((err) => {
            log.error(`Failed to set MAC address of ${ap}`, err.message);
          });
        }
      }
    }
  }

  async getMac(index) {
    const mac = await exec(`seq 0 5 | xargs -I ZZZ -n 1 sudo i2cget -y 1 0x50 0x${index}ZZZ | cut -d 'x' -f 2 | paste -sd ':'`)
          .then(result => result.stdout.trim())
          .catch((err) => {
            log.error(`Failed to get MAC address for index ${index} from EPROM`, err.message);
          });
    return mac;
  }
}

module.exports = PurplePlatform;
