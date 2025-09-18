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

const chai = require('chai');
const expect = chai.expect;

const { AssetStatus, Station, StationStatus, ApStats, getAssetStatus } = require('../../util/assets.js');
const { parseStations, parseWifiDevices } = require('../../util/wifi.js');


const outputWifiDev = `phy#0
	Interface wlan1
		ifindex 5
		wdev 0x2
		addr 20:6d:31:26:60:11
		ssid o1
		type AP
		channel 36 (5180 MHz), width: 160 MHz, center1: 5250 MHz
		txpower 8.00 dBm
		multicast TXQ:
			qsz-byt	qsz-pkt	flows	drops	marks	overlmt	hashcol	tx-bytes	tx-packets
			0	0	244617	0	0	0	39	20905634		290768
		Radios: 0 1
	Interface wlan0
		ifindex 4
		wdev 0x1
		addr 20:6d:31:26:60:10
		type managed
		txpower 3.00 dBm
		multicast TXQ:
			qsz-byt	qsz-pkt	flows	drops	marks	overlmt	hashcol	tx-bytes	tx-packets
			0	0	0	0	0	0	0	0		0
		Radios: 0 1
`

const outputAllStat = `30:d5:3e:cf:f8:76
flags=[AUTH][ASSOC][AUTHORIZED][WMM][HT][VHT][HE]
aid=2
listen_interval=20
dot11RSNAStatsSTAAddress=30:d5:3e:cf:f8:76
dot11RSNAStatsVersion=1
dot11RSNAStatsSelectedPairwiseCipher=00-0f-ac-4
wpa=2
AKMSuiteSelector=00-0f-ac-2
rx_packets=3572
tx_packets=2502
rx_bytes=863616
tx_bytes=737984
inactive_msec=9840
signal=-58
rx_rate_info=6485
tx_rate_info=2882
last_ack_signal=-57
connected_time=604
min_txpower=-7
max_txpower=21
ext_capab=0000000000000040000020
62:b3:3f:01:76:13
flags=[AUTH][ASSOC][AUTHORIZED][WMM][HT][VHT][HE]
aid=1
dot11RSNAStatsSTAAddress=62:b3:3f:01:76:13
dot11RSNAStatsVersion=1
dot11RSNAStatsSelectedPairwiseCipher=00-0f-ac-4
wpa=2
AKMSuiteSelector=00-0f-ac-2
connected_time=6820
rx_packets=558341
tx_packets=11069310
rx_bytes=48693760
tx_bytes=13602493376
inactive_msec=6820
signal=-65
min_txpower=8
max_txpower=20
`

describe('Test assets event', function () {
    this.timeout(10000);
    describe('Test construct AssetStatus', () => {
        it('should return 2 stations', () => {
            const result = new AssetStatus({
                mac: '20:6d:31:26:60:11',
                u: 79733,
                version: '1.0.0',
                imageVersion: '1.0.0',
                model: 'Firewalla',
                branch: 'master',
                test: "test",
                test2: "test2",
            });
            expect(result).to.be.an('object');
            expect(result.mac).to.equal('20:6d:31:26:60:11');
            expect(result.u).to.equal(79733);
            expect(result.version).to.equal('1.0.0');
            expect(result.imageVersion).to.equal('1.0.0');
            expect(result.model).to.equal('Firewalla');
            expect(result.branch).to.equal('master');
            expect(Object.hasOwnProperty(result, 'test')).to.be.false;
            expect(Object.hasOwnProperty(result, 'test2')).to.be.false;
        });

    });

    describe('Test construct Station', () => {
        it('should return 2 stations', () => {
            const result = new Station({
                macAddr: '6A:A9:DB:82:DC:12',
                txRate: 900,
                rxRate: 200,
                rssi: -43,
                snr: 20,
                assocTime: 137,
                channel: 31,
                ssid: 'FW-SSID',
                intf: 'wlan1',
                band: '2g',
                test: 'test',
                test2: 'test2',
            });
            expect(result).to.be.an('object');
            expect(result.macAddr).to.equal('6A:A9:DB:82:DC:12');
            expect(result.txRate).to.equal(900);
            expect(result.rxRate).to.equal(200);
            expect(result.rssi).to.equal(-43);
            expect(result.snr).to.equal(20);
            expect(result.assocTime).to.equal(137);
            expect(result.channel).to.equal(31);
            expect(result.ssid).to.equal('FW-SSID');
            expect(result.intf).to.equal('wlan1');
            expect(result.band).to.equal('2g');
            expect(Object.hasOwnProperty(result, 'test')).to.be.false;
            expect(Object.hasOwnProperty(result, 'test2')).to.be.false;
        });

        it('should contain a list of 2 stations', () => {
            const result = new StationStatus([
                {
                    macAddr: '6A:A9:DB:82:DC:12',
                },
                {
                    macAddr: '6A:A9:DB:82:DC:13',
                }
            ]);
            expect(result.stations).to.be.an('array');
            expect(result.stations).to.have.length(2);
        });
    });


    describe('Test AssetStatus fields', () => {
        it('should set fields stations', async () => {
            const assetsStatus = await getAssetStatus();
            // set ap stats fields
            const wlanDevs = parseWifiDevices(outputWifiDev.split('\n').map(line => line.trim()));
            const apStats = wlanDevs.map(asset => new ApStats(asset));

            // set stations fields
            const stations = parseStations(outputAllStat.split('\n').map(line => line.trim()));

            assetsStatus.aps = apStats;
            assetsStatus.devices = stations.map(station => new Station(station));
            assetsStatus.devices.map(station => station.setFields({
                ssid: apStats[0].ssid,
                bssid: apStats[0].bssid,
                channel: apStats[0].channel,
                band: apStats[0].band,
                intf: apStats[0].intf,
            }));

            expect(assetsStatus.mac).to.be.a('string');
            expect(assetsStatus.otherMacs).to.be.an('array');
            expect(assetsStatus.version).to.be.a('string');
            expect(assetsStatus.imageVersion).to.equal('');
            expect(assetsStatus.model).to.equal('orange');
            expect(assetsStatus.backhaulState).to.equal('Unknown');
            expect(assetsStatus.upstreamAPs).to.be.an('array');
            expect(assetsStatus.upstreamAPs).to.have.length(0);
            expect(assetsStatus.downstreamEtherMACs).to.be.an('array');
            expect(assetsStatus.downstreamEtherMACs).to.have.length(0);
            expect(assetsStatus.downstreamWifiMACs).to.be.an('array');
            expect(assetsStatus.downstreamWifiMACs).to.have.length(0);
            expect(assetsStatus.upstreamRSSIs).to.be.an('array');
            expect(assetsStatus.upstreamRSSIs).to.have.length(0);
            expect(assetsStatus.u).to.be.a('number');
            expect(assetsStatus.pu).to.be.a('number');
            expect(assetsStatus.util).to.be.an('object');
            expect(assetsStatus.freeMem).to.be.a('number');
            expect(assetsStatus.fwapRSS).to.be.a('number');

            // aps required fields
            expect(assetsStatus.aps).to.be.an('array');
            expect(assetsStatus.aps).to.have.length(2);
            expect(assetsStatus.aps[0].ssid).to.equal('o1');
            expect(assetsStatus.aps[0].bssid).to.equal('20:6d:31:26:60:11');
            expect(assetsStatus.aps[0].channel).to.equal(36);
            expect(assetsStatus.aps[0].band).to.equal('5g');
            expect(assetsStatus.aps[0].width).to.equal(160);
            expect(assetsStatus.aps[0].intf).to.equal('wlan1');
            expect(assetsStatus.aps[0].mode).to.equal('ap');
            expect(assetsStatus.aps[0].mesh).to.equal(false);

            // devices required fields
            expect(assetsStatus.devices).to.be.an('array');
            expect(assetsStatus.devices).to.have.length(2);
            expect(assetsStatus.devices[0].macAddr).to.equal('30:D5:3E:CF:F8:76');
            expect(assetsStatus.devices[0].txRate).to.equal(0);
            expect(assetsStatus.devices[0].rxRate).to.equal(0);
            expect(assetsStatus.devices[0].rssi).to.equal(-58);
            expect(assetsStatus.devices[0].snr).to.equal(0);
            expect(assetsStatus.devices[0].assocTime).to.equal(604);
            expect(assetsStatus.devices[0].channel).to.equal(36);
            expect(assetsStatus.devices[0].ssid).to.equal('o1');
            expect(assetsStatus.devices[0].intf).to.equal('wlan1');
            expect(assetsStatus.devices[0].band).to.equal('5g');
        });
    });
});
