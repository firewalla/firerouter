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

const exec = require('child-process-promise').exec;
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const log = require('./logger.js')('wifi');
const { getHiddenFolder } = require('./firerouter');

const hostapdPath = `${getHiddenFolder()}/run/hostapd`;
const regex_mac = /^([0-9a-f][0-9a-f]:){5}[0-9a-f][0-9a-f]$/;
const regex_channel = /^channel\s+(\d{1,3})\s+\((\d+) MHz\).*width:\s+(\d{1,3})\s+MHz/;
const regex_interface = /^Interface\s+([^\s]+)\s*/;

// [{ name: 'wlan1', addr: '20:6d:31:26:60:11', ssid: 'o1', type: 'AP', channel: '36 (5180 MHz) }]
async function listWifiDevices() {
    const cmd = `iw dev`;
    const result = await exec(cmd).then(result => result.stdout.trim()).catch(err => {
        log.error(`Failed to list wifi devices`, err.message);
        return "";
    });
    const lines = result.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    return parseWifiDevices(lines);
}

async function getWifiDevice(intf) {
    const cmd = `iw dev ${intf} info`;
    const result = await exec(cmd).then(result => result.stdout.trim()).catch(err => {
        log.error(`Failed to get wifi ${intf} info`, err.message);
        return "";
    });
    const lines = result.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const devices = parseWifiDevices(lines);
    return devices.find(device => device.intf === intf);
}

function parseWifiDevices(lines) {
    const devices = [];
    for (const line of lines) {
        if (line.startsWith('Interface')) {
            devices.push({});
        }
        parseWifiDevice(devices[devices.length - 1], line);
    }
    return devices;
}

// Interface wlan1
// 	ifindex 5
// 	wdev 0x2
// 	addr 20:6d:31:26:60:11
// 	ssid o1
// 	type AP
// 	wiphy 0
// 	channel 36 (5180 MHz), width: 160 MHz, center1: 5250 MHz
// 	txpower 8.00 dBm
// 	multicast TXQ:
// 		qsz-byt	qsz-pkt	flows	drops	marks	overlmt	hashcol	tx-bytes	tx-packets
// 		0	0	4988	0	0	0	0	462225		6506
// 	Radios: 0 1

function parseWifiDevice(device, line) {
    if (line.startsWith('Interface')) {
        device.intf = parseInterface(line);
    } else if (line.startsWith('addr')) {
        device.bssid = line.split(' ')[1].toUpperCase();
    } else if (line.startsWith('ssid')) {
        device.ssid = line.split(' ')[1];
    } else if (line.startsWith('type')) {
        device.wifi_type = line.split(' ')[1];
        device.mode = parseMode(device.wifi_type);
    } else if (line.startsWith('channel')) {
        const { channel, freq, width } = parseChannel(line) || {};
        device.channel = channel || 0;
        device.freq = freq || 0;
        device.width = width || 0;
    } else if (line.startsWith('txpower')) {
        device.txpower = parseInt(line.split(' ')[1]) || 0;
    }
}

function parseInterface(line) {
    const match = regex_interface.exec(line);
    if (!match) {
        log.error(`Failed to parse interface from ${line}`);
        return null;
    }
    if (match.length < 2) {
        log.warn(`Failed to parse interface from ${line}`);
        return null;
    }
    return match[1];
}

function parseMode(mode) {
    if (mode === 'AP') {
        return 'ap';
    } else if (mode === 'managed') {
        return 'sta';
    }
    return '';
}

function parseChannel(channel) {
    const match = regex_channel.exec(channel);
    if (!match) {
        log.error(`Failed to parse channel from ${channel}`);
        return null;
    }
    if (match.length < 4) {
        log.warn(`Failed to parse channel from ${channel}`);
        return null;
    }
    return {
        channel: parseInt(match[1]),
        freq: parseInt(match[2]),
        width: parseInt(match[3]),
    };
}


async function listStations(intf = 'wlan1') {
    // check if path exists
    if (!await exec(`sudo stat ${hostapdPath}/${intf}`).then(() => true).catch(() => false)) {
        log.debug(`Hostapd path ${hostapdPath}/${intf} does not exist, skip`);
        return [];
    }
    const cmd = `sudo hostapd_cli -p ${hostapdPath} -i ${intf} all_sta`;
    const result = await exec(cmd).then(result => result.stdout.trim()).catch(err => {
        log.error(`Failed to list ${intf} stations`, err.message);
        return "";
    });
    const lines = result.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    return parseStations(lines);
}

async function listStationMacs(intf = 'wlan1') {
    const cmd = `sudo hostapd_cli -p ${hostapdPath} -i ${intf} list_sta`;
    const status = await exec(cmd).then(result => result.stdout.trim()).catch(err => {
        log.error(`Failed to list ${intf} station macs`, err.message);
        return "";
    });
    return status.split('\n').map(line => line.trim()).filter(line => line.length > 0);
}

async function getStationStatus(mac) {
    const cmd = `sudo hostapd_cli -p ${hostapdPath} -i wlan1 sta ${mac}`;
    const result = await exec(cmd).then(result => result.stdout.trim()).catch(err => {
        log.error(`Failed to get ${intf} sta ${mac}`, err.message);
        return "";
    });
    const lines = result.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const devices = parseStations(lines);
    if (devices.length === 0) {
        return null;
    }
    return devices.find(device => device.mac === mac);
}

function parseStations(lines) {
    const stations = [];
    for (const line of lines) {
        if (!line.includes('=') && regex_mac.test(line)) {
            stations.push({ mac: line.toUpperCase() });
            continue;
        }
        parseStation(stations[stations.length - 1], line);
    }
    return stations;
}

// 9a:75:ab:b5:34:cb
// flags=[AUTH][ASSOC][AUTHORIZED][WMM][HT][VHT][HE]
// aid=2
// capability=0x111
// listen_interval=1
// supported_rates=8c 12 98 24 b0 48 60 6c
// timeout_next=NULLFUNC POLL
// dot11RSNAStatsSTAAddress=9a:75:ab:b5:34:cb
// dot11RSNAStatsVersion=1
// dot11RSNAStatsSelectedPairwiseCipher=00-0f-ac-4
// dot11RSNAStatsTKIPLocalMICFailures=0
// dot11RSNAStatsTKIPRemoteMICFailures=0
// wpa=2
// AKMSuiteSelector=00-0f-ac-2
// hostapdWPAPTKState=11
// hostapdWPAPTKGroupState=0
// hostapdMFPR=0
// rx_packets=19045
// tx_packets=9694
// rx_bytes=1688544
// tx_bytes=4315584
// inactive_msec=6230
// signal=-42
// rx_rate_info=12009
// tx_rate_info=6485
// rx_vht_mcs_map=fffa
// tx_vht_mcs_map=fffa
// ht_mcs_bitmask=ffff0000000000000000
// last_ack_signal=-41
// connected_time=14521
// supp_op_classes=81515354737475767778797a7b7c7d7e7f808183848882
// min_txpower=8
// max_txpower=20
// he_capab=030110da40080c300089fd0980080e0c00fafffafffafffaff791cc7711cc771
// vht_caps_info=0x3391f9f6
// vht_capab=f6f99133faff0c03faff0c23
// ht_caps_info=0x09ef
// ext_capab=0400080001004040002020
function parseStation(station, line) {
    const parts = line.split('=');
    if (parts.length !== 2) {
        return;
    }
    const key = parts[0].trim();
    const value = parts[1].trim();

    switch (key) {
        case '':
            station.keyId = value;
            break;
        case 'vlan_id':
            station.vlanId = parseInt(value);
            break;
        case 'connected_time':
            station.connectedTime = parseInt(value);
            break;
        case 'last_ack_signal':
            station.lastAckSignal = parseInt(value);
            break;
        case 'min_txpower':
            station.minTxPower = parseInt(value);
            break;
        case 'max_txpower':
            station.maxTxPower = parseInt(value);
            break;
        case 'signal':
            station.signal = parseInt(value);
            break;
        case 'rx_packets':
            station.rxPackets = parseInt(value);
            break;
        case 'tx_packets':
            station.txPackets = parseInt(value);
            break;
        case 'rx_bytes':
            station.rxBytes = parseInt(value);
            break;
        case 'tx_bytes':
            station.txBytes = parseInt(value);
            break;
        case 'wpa':
            station.wpa = parseInt(value);
            break;
        case 'AKMSuiteSelector':
            station.akmSuiteSelector = value;
            break;
        case 'dot11RSNAStatsSelectedPairwiseCipher':
            station.dot11RSNACipher = value;
            break;
        default:
            station[key] = value;
            break;
    }
}

function getBand(freq) {
    return freq < 3000 ? '2g' : freq < 5900 ? '5g' : '6g';
}

module.exports = {
    getBand,
    getStationStatus,
    getWifiDevice,
    listStationMacs,
    listStations,
    listWifiDevices,
    parseChannel,
    parseInterface,
    parseStations,
    parseWifiDevices,
}