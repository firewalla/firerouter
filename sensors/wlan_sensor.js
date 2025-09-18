/*    Copyright 2019-2025 Firewalla Inc
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

const Sensor = require("./sensor.js");
const dgram = require('dgram');
const exec = require('child-process-promise').exec;
const wifi = require('../util/wifi.js');
const assets = require('../util/assets.js');
const firerouter = require('../util/firerouter.js');

class WLANSensor extends Sensor {
    async run() {
        // only support in orange model
        const boardName = await firerouter.getBoardName();

        // TODO: remove purple model
        if (boardName != 'orange' && boardName != 'purple') {
            this.log.info(`WLANPlugin only support in orange model, skip model ${boardName}`);
            return;
        }

        this.wg_ap = "wg_ap"
        this.name = "wg_wlan1"

        this.port = 8838
        this.ipAddr = await exec(`ip addr show dev ${this.name} | awk '/inet /' | awk '{print $2}'`, { encoding: "utf8" })
            .then(result => result.stdout.trim().split("/")[0])
            .catch((err) => {
                this.log.error(`Failed to get target address for ${this.name}`, err.message);
                return null;
            });;
        this.client = dgram.createSocket({
            type: "udp4",
            reuseAddr: true
        });
        this.client.bind(this.port, this.ipAddr);

        // send ap status every 11 seconds
        setInterval(async () => {
            const event = await this.getAssetStatusEvent();
            await this.sendMessage(JSON.stringify(event));
        }, 11000);
    }

    // AssetStatusEvent
    async getAssetStatusEvent() {
        const status = await this._getAssetStatus();
        const type = "assets_msg::status";
        const event = Object.assign({}, status, { type: type });
        return event;
    }

    async _getAssetStatus() {
        const apStatus = await assets.getAssetStatus();
        const wlanAssets = await wifi.listWifiDevices();
        const apStats = wlanAssets.map(asset => new assets.ApStats(asset));
        apStatus.aps = Object.fromEntries(apStats.map(ap => [ap.intf, ap]));

        const devices = [];
        for (const apstat of apStats) {
            const stations = await wifi.listStations(apstat.intf);
            const apDevices = stations.map(station => new assets.Station(station));
            apDevices.map(station => station.setFields({
                ssid: apstat.ssid,
                bssid: apstat.bssid,
                channel: apstat.channel,
                band: apstat.band,
                intf: apstat.intf,
            }));
            devices.push(...apDevices);
        }
        apStatus.devices = devices;
        return apStatus;
    }

    async sendMessage(msg) {
        this.log.info(`Sending message to fwapc: ${msg}`);
        const addr = await exec(`ip addr show dev ${this.wg_ap} | awk '/inet /' | awk '{print $2}'`, { encoding: "utf8" })
            .then(result => result.stdout.trim().split("/")[0])
            .catch((err) => {
                this.log.error(`Failed to get target address for ${this.name}`, err.message);
                return null;
            });

        if (!addr) {
            this.log.error(`Failed to get address for ${this.wg_ap}, abort sending message to fwapc`);
            return;
        }

        this.client.send(msg, 0, msg.length, this.port, addr, (err) => {
            if (err) {
                this.log.warn('Failed to send message to fwapc', err);
            } else {
                this.log.info(`Sent ${msg.length} bytes to fwapc ${addr}:${this.port}`);
            }
        });
    }
}

module.exports = WLANSensor;