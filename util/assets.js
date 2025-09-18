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

const _ = require('lodash');
const os = require('os');
const exec = require('child-process-promise').exec;
const log = require('./logger.js')('assets');
const { getBand } = require('./wifi.js');
const firerouter = require('./firerouter.js');

const BACKHAUL_STATE = {
    Unknown: 'Unknown',
    Transitioning: 'Transitioning',
    Ethernet: 'Ethernet',
    Wireless: 'Wireless',
};

const AssetStatusSchema = {
    // required fields below
    mac: { type: 'string', default: '', required: true },
    otherMacs: { type: 'array', default: [], required: true },
    version: { type: 'string', default: '', required: true },
    imageVersion: { type: 'string', default: '', required: true },
    model: { type: 'string', default: '', required: true },
    backhaulState: { type: 'string', default: BACKHAUL_STATE.Unknown, required: true },
    upstreamAPs: { type: 'array', default: [], required: true },
    downstreamEtherMACs: { type: 'array', default: [], required: true },
    downstreamWifiMACs: { type: 'array', default: [], required: true },
    upstreamRSSIs: { type: 'array', default: [], required: true },
    u: { type: 'number', default: 0, required: true }, // uptime
    pu: { type: 'number', default: 0, required: true }, // process uptime
    util: { type: 'object', default: {}, required: true }, // medium utilization
    freeMem: { type: 'number', default: 0, required: true },
    fwapRSS: { type: 'number', default: 0, required: true },
    devices: { type: 'array', default: [], required: true },
    aps: { type: 'object', default: {}, required: true },
    eths: { type: 'object', default: {}, required: true },
    wifis: { type: 'object', default: {}, required: true },
    addrs: { type: 'object', default: {}, required: true },
    lastConfigTs: { type: 'number', default: 0, required: true },
    aip: { type: 'boolean', default: false, required: true },
    ecmConnCount: { type: 'number', default: 0, required: true },
    ecmAccConnCount: { type: 'number', default: 0, required: true },
    noArpCache: { type: 'boolean', default: false, required: true },
    lastConfigApplyTs: { type: 'number', default: 0, required: true },
    // optional below
    imageVersionAvailable: { type: 'string', default: '' },
    imageLastUpdateTs: { type: 'number', default: 0 },
    powerType: { type: 'string', default: '' },
    license: { type: 'string', default: '' },
    eid: { type: 'string', default: '' },
    gid: { type: 'string', default: '' },
    branch: { type: 'string', default: '' },
    fwapLastUpdated: { type: 'number', default: 0 },
    upstreamRxRates: { type: 'array', default: [] },
    upstreamTxRates: { type: 'array', default: [] },
    upstreamMLO: { type: 'array', default: [] },
    activeUplink: { type: 'string', default: '' },
    lastActiveUplinkTs: { type: 'number', default: 0 },
    latencyToController: { type: 'number', default: 0 },
    pid: { type: 'number', default: 0 },
    session: { type: 'string', default: '' },
    locate: { type: 'boolean', default: false },
    cpuTemp: { type: 'number', default: 0 },
    rootfs: { type: 'string', default: '' },
    lastConfigHash: { type: 'string', default: '' },
    lastHeartbeatTs: { type: 'number', default: 0 },
    epoch: { type: 'number', default: 0 },
    mountRootMode: { type: 'string', default: '' },
};

async function getAssetStatus() {
    // get wlan0 mac
    const macAddr = await exec(`ip addr show dev wlan0 | grep ether | awk '{print $2}'`).then(result => result.stdout.trim().toUpperCase()).catch((err) => {
        log.warn('Failed to get wlan0 mac', err);
        return '00:00:00:00:00:00'; // default
    });
    const version = await exec(`cat /etc/firewalla_release | grep Version | awk '{print $2}'`).then(result => result.stdout.trim()).catch((err) => {
        log.warn('Failed to get version', err);
        return ''; // default
    });
    const uptime = await exec(`cat /proc/uptime | awk '{print $1}'`).then(result => parseInt(result.stdout.trim())).catch((err) => {
        log.warn('Failed to get uptime', err);
        return 0; // default
    });
    const data = {
        mac: macAddr || '00:00:00:00:00:00',
        model: await firerouter.getBoardName(),
        version: version,
        u: uptime || 0,
        pu: parseInt(process.uptime()) || 0,
        fwapRSS: process.memoryUsage().rss || 0,
        freeMem: os.freemem() || 0,
    };
    return new AssetStatus(data);
}

class AssetStatus {
    constructor(data) {
        if (!_.isObject(data)) {
            log.warn('constructor AssetStatus error: data must be an object');
            return null;
        }
        Object.assign(this, this.defaults());
        this.setFields(data);
    }

    defaults() {
        return Object.fromEntries(
            Object.entries(AssetStatusSchema).filter(([key, field]) => field.required).map(([key, field]) => [key, field.default])
        );
    }

    setFields(data) {
        Object.assign(this, Object.fromEntries(
            Object.entries(data).filter(([key, field]) => AssetStatusSchema.hasOwnProperty(key))
        ));
    }
}

const StationSchema = {
    macAddr: { type: 'string', default: '', required: true },
    txRate: { type: 'number', default: 0, required: true },
    rxRate: { type: 'number', default: 0, required: true },
    rssi: { type: 'number', default: 0, required: true },
    snr: { type: 'number', default: 0, required: true },
    assocTime: { type: 'number', default: 0, required: true },
    channel: { type: 'number', default: 0, required: true },
    ssid: { type: 'string', default: '', required: false },
    intf: { type: 'string', default: '', required: false },
    bssid: { type: 'string', default: '', required: false },
    band: { type: 'string', default: '', required: false },
    phymode: { type: 'string', default: '', required: false },
    rxnss: { type: 'number', default: 0, required: false },
    txnss: { type: 'number', default: 0, required: false },
    idle: { type: 'number', default: 0, required: false },
    state: { type: 'number', default: 0, required: false },
    mlo: { type: 'object', default: null, required: false },
    capRM: { type: 'boolean', default: false, required: true }, // cap_radio_measurement
    capRMP: { type: 'boolean', default: false, required: true }, // cap_radio_measurement_passive
    capRMA: { type: 'boolean', default: false, required: true }, // cap_radio_measurement_active
    capRMT: { type: 'boolean', default: false, required: true }, // cap_radio_measurement_table
    capBT: { type: 'boolean', default: false, required: true }, // cap_bss_transition
    cap2g: { type: 'boolean', default: false, required: false },
    cap5g: { type: 'boolean', default: false, required: false },
    cap6g: { type: 'boolean', default: false, required: false },
    assocTs: { type: 'number', default: 0, required: true },
    disassocTs: { type: 'number', default: 0, required: false },
    vlanId: { type: 'number', default: 0, required: false },
    dvlanVlanId: { type: 'number', default: 0, required: false },
    rssiTrend: { type: 'number', default: 0, required: false },
    vendor: { type: 'string', default: '', required: false },
    ipv4: { type: 'string', default: '', required: false },
    ipv6: { type: 'array', default: [], required: false },
    mesh: { type: 'boolean', default: false, required: false },
    control: { type: 'object', default: null, required: false },
    curTxRate: { type: 'number', default: 0, required: false },
    curRxRate: { type: 'number', default: 0, required: false },
    curTxRateHistory: { type: 'array', default: [], required: false },
    curRxRateHistory: { type: 'array', default: [], required: false },
    lastTxBytes: { type: 'number', default: 0, required: false },
    lastRxBytes: { type: 'number', default: 0, required: false },
    lastTxAggrBytes: { type: 'number', default: 0, required: false },
    lastTs: { type: 'number', default: 0, required: false },
    wpa: { type: 'number', default: 0, required: false },
    akmSuiteSelector: { type: 'string', default: '', required: false },
    dot11RsnaCipher: { type: 'string', default: '', required: false },
    dot1xUserName: { type: 'string', default: '', required: false },
    wpax: { type: 'string', default: '', required: false },
    connStats: { type: 'object', default: null, required: false },
};

class Station {
    constructor(data) {
        if (!_.isObject(data)) {
            log.warn('constructor Station error: data must be an object');
            return null;
        }
        if (data.mac && !data.macAddr) {
            data.macAddr = data.mac;
        }
        if (data.signal && !data.rssi) {
            data.rssi = data.signal;
        }
        if (data.connectedTime && !data.assocTime) {
            data.assocTime = data.connectedTime;
        }
        Object.assign(this, this.defaults());
        this.setFields(data);
    }

    defaults() {
        return Object.fromEntries(
            Object.entries(StationSchema).filter(([key, field]) => field.required).map(([key, field]) => [key, field.default])
        );
    }

    setFields(data) {
        Object.assign(this, Object.fromEntries(
            Object.entries(data).filter(([key, field]) => StationSchema.hasOwnProperty(key)))
        );
    }
}

class StationStatus {
    constructor(stations) {
        if (!_.isArray(stations)) {
            log.warn('constructor StationStatus error: stations must be an array');
            return null;
        }
        this.stations = stations.map(station => new Station(station));
    }
}

const ApStatsSchema = {
    ssid: { type: 'string', default: '', required: true },
    bssid: { type: 'string', default: '', required: true },
    channel: { type: 'number', default: 0, required: true },
    band: { type: 'string', default: '', required: true },
    width: { type: 'number', default: 0, required: true },
    intf: { type: 'string', default: '', required: true },
    mode: { type: 'string', default: '', required: true },
    mesh: { type: 'boolean', default: false, required: true },
    mlo: { type: 'string', default: '', required: false },
    max_rate: { type: 'number', default: 0, required: false },
    tx_bytes: { type: 'number', default: 0, required: false },
    rx_bytes: { type: 'number', default: 0, required: false },
    bridge: { type: 'string', default: '', required: false },
    link_state: { type: 'string', default: '', required: false },
    tx_power: { type: 'number', default: 0, required: false },
    tx_bcast: { type: 'number', default: 0, required: false },
    rx_bcast: { type: 'number', default: 0, required: false },
    tx_mcast: { type: 'number', default: 0, required: false },
    rx_mcast: { type: 'number', default: 0, required: false },
    phy_type: { type: 'number', default: 0, required: false },
    opclass: { type: 'number', default: 0, required: false },
    up_bssid: { type: 'string', default: '', required: false },
    up_rssi: { type: 'number', default: 0, required: false },
    up_tx: { type: 'number', default: 0, required: false },
    up_rx: { type: 'number', default: 0, required: false },
    up_in_use: { type: 'boolean', default: false, required: false },
};

class ApStats {
    // from wirelessInfo
    constructor(data) {
        if (!_.isObject(data)) {
            log.warn('constructor ApStats error: data must be an object');
            return null;
        }
        Object.assign(this, this.defaults());
        if (data.freq && !data.band) {
            data.band = getBand(data.freq);
        }
        this.setFields(data);
    }

    defaults() {
        return Object.fromEntries(
            Object.entries(ApStatsSchema).filter(([key, field]) => field.required).map(([key, field]) => [key, field.default])
        );
    }

    setFields(data) {
        Object.assign(this, Object.fromEntries(
            Object.entries(data).filter(([key, field]) => ApStatsSchema.hasOwnProperty(key)))
        );
    }
}

module.exports = {
    ApStats,
    AssetStatus,
    Station,
    StationStatus,
    getAssetStatus,
    BACKHAUL_STATE,
};