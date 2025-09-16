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

const { parseStations, parseWifiDevices, parseChannel, parseInterface } = require('../../util/wifi.js');

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

describe('Test wifi util', function () {
    this.timeout(10000);
    describe('parseStations', () => {
        it('should return 2 stations', () => {
            const result = parseStations(outputAllStat.split('\n').map(line => line.trim()));
            expect(result).to.be.an('array');
            expect(result).to.have.length(2);
            expect(result[0].mac).to.equal('30:D5:3E:CF:F8:76');
            expect(result[0].rxPackets).to.equal('3572');
            expect(result[0].txPackets).to.equal('2502');
            expect(result[0].rxBytes).to.equal('863616');
            expect(result[0].txBytes).to.equal('737984');
            expect(result[0].minTxPower).to.equal('-7');
            expect(result[0].maxTxPower).to.equal('21');
            expect(result[0].signal).to.equal('-58');
            expect(result[0].connectedTime).to.equal('604');
            expect(result[0].wpa).to.equal('2');
            expect(result[0].AKMSuiteSelector).to.equal('00-0f-ac-2');
            expect(result[1].mac).to.equal('62:B3:3F:01:76:13');
            expect(result[1].rxPackets).to.equal('558341');
            expect(result[1].txPackets).to.equal('11069310');
            expect(result[1].rxBytes).to.equal('48693760');
            expect(result[1].txBytes).to.equal('13602493376');
            expect(result[1].minTxPower).to.equal('8');
            expect(result[1].maxTxPower).to.equal('20');
            expect(result[1].signal).to.equal('-65');
            expect(result[1].connectedTime).to.equal('6820');
            expect(result[1].wpa).to.equal('2');
            expect(result[1].AKMSuiteSelector).to.equal('00-0f-ac-2');
            expect(result[1].dot11RSNACipher).to.equal('00-0f-ac-4');
        });

    });

    describe('parseWifiDevices', () => {
        it('should match interface', () => {
            const result = parseInterface("	Interface wlan1".trim());
            expect(result).to.equal('wlan1');
        });

        it('should match channel', () => {
            const result = parseChannel("		channel 36 (5180 MHz), width: 160 MHz, center1: 5250 MHz".trim());
            expect(result.channel).to.equal(36);
            expect(result.freq).to.equal(5180);
            expect(result.width).to.equal(160);
        });

        it('should return 2 devices', () => {
            const result = parseWifiDevices(outputWifiDev.split('\n').map(line => line.trim()));
            expect(result).to.be.an('array');
            expect(result).to.have.length(2);
            expect(result[0].intf).to.equal('wlan1');
            expect(result[0].addr).to.equal('20:6d:31:26:60:11');
            expect(result[0].ssid).to.equal('o1');
            expect(result[0].wifi_type).to.equal('AP');
            expect(result[0].channel).to.equal(36);
            expect(result[0].freq).to.equal(5180);
            expect(result[0].width).to.equal(160);
            expect(result[0].txpower).to.equal(8);
            expect(result[1].intf).to.equal('wlan0');
            expect(result[1].addr).to.equal('20:6d:31:26:60:10');
            expect(result[1].wifi_type).to.equal('managed');
            expect(result[1].txpower).to.equal(3);
        });
    });
});
