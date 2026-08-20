/*    Copyright 2019-2026 Firewalla Inc.
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

const Promise = require('bluebird');
const { exec } = require('child-process-promise');
const log = require('../util/logger.js')('util');
const uuid = require('uuid');
const validator = require('validator');

const _ = require('lodash')

function extend(target) {
  var sources = [].slice.call(arguments, 1);
  sources.forEach(function (source) {
    for (var prop in source) {
      target[prop] = source[prop];
    }
  });
  return target;
}

function delay(t) {
  return new Promise(function (resolve) {
    setTimeout(resolve, t);
  });
}

function wrapIptables(rule) {
  const res = rule.match(/ -[AID] /);

  if (!res) return rule;

  const command = res[0];
  const checkRule = rule.replace(command, " -C ");

  switch (command) {
    case " -I ":
    case " -A ":
      return `bash -c '${checkRule} &>/dev/null || ${rule}'`;

    case " -D ":
      return `bash -c '${checkRule} &>/dev/null && ${rule}; true'`;
  }
}

async function generatePSK(ssid, passphrase) {
  const platform = require('../platform/PlatformLoader.js').getPlatform()
  const ssidHex = _getCLangHexString(ssid);
  const passphraseHex = _getCLangHexString(passphrase);
  const lines = await exec(`bash -c "${await platform.getWpaPassphraseBinPath()} ${ssidHex} ${passphraseHex}"`).then((result) => result.stdout.trim().split('\n').map(line => line.trim())).catch(err => []);
  for (const line of lines) {
    if (line.startsWith("psk="))
      return line.substring(4);
  }
  return null;
}

function _getCLangHexString(str) {
  const hexArray = getHexStrArray(str);
  return `$'${hexArray.map(hex => `\\x${hex}`).join("")}'`;
}

function getHexStrArray(str) {
  const result = [];
  const buf = Buffer.from(str, 'utf8');
  for (let i = 0; i < buf.length; i++) {
    // pad to 2 digits, callers that join without a separator rely on a fixed width per byte
    result.push(Number(buf[i]).toString(16).padStart(2, '0'));
  }
  return result;
}

async function generateWpaSupplicantConfig(key, values) {
  const storage = require('./storage.js');
  let value = values[key];
  switch (key) {
    case "ssid":
    case "password":
    case "wep_key0":
    case "wep_key1":
    case "wep_key2":
    case "wep_key3":
    case "identity":
    case "phase2":
    case "sae_password":
      // use hex string for ssid/eap password in case of special characters
      value = getHexStrArray(value).join("");
      break;
    case "psk":
      value = await generatePSK(values["ssid"], value);
      break;
    case "ca_cert":
    case "ca_cert2":
    case "client_cert":
    case "client_cert2":
    case "private_key":
    case "private_key2":
      value = `"${storage.getSavedFilePath(value)}"`;
      break;
    case "anonymous_identity":
    case "phase1":
    case "private_key_passwd":
    case "private_key2_passwd":
      value = `"${value}"`;
      break
    default:
      if (Array.isArray(value))
        value = value.join(' ')
  }
  return value;
}

function parseEscapedString(escaped) {
  if (!escaped) return ''
  if (!_.isString(escaped)) throw new Error('Invalid Input', escaped)

  const chArray = []
  let i = 0
  while (i < escaped.length) {
    if (escaped[i] === '\\') {
      i ++
      switch(escaped[i]) {
        case 't':
          i ++
          chArray.push('\t')
          continue
        case 'v':
          i ++
          chArray.push('\v')
          continue
        case 'x':
          i ++
          const num = parseInt(escaped[i++] + escaped[i++], 16)
          chArray.push(String.fromCharCode(num))
          continue
      }
    }
    // \' \" \\ are pushed here
    chArray.push(escaped[i++])
  }
  return Buffer.from(chArray.join(''), 'latin1').toString()
}

function parseHexString(str) {
  if (!str) return ''
  if (!_.isString(str)) throw new Error('Invalid Input', str)

  const chArray = []
  let i = 0
  while (i < str.length) {
    const num = parseInt(str[i++] + str[i++], 16)
    chArray.push(String.fromCharCode(num))
  }
  return Buffer.from(chArray.join(''), 'latin1').toString()
}

// js equivalent of piping command output through `tail -n 1`
function lastLine(stdout) {
  const lines = (stdout || "").trim().split('\n');
  return lines[lines.length - 1].trim();
}

function freqToChannel(freq) {
  if (freq >= 2412 && freq <= 2472) return Math.round((freq - 2407) / 5)
  else if (freq == 2484) return 14
  else if (freq > 5000 && freq < 6000) return Math.round((freq - 5000) / 5)
  else {
    log.error('Unknown frequency', JSON.stringify(freq))
    return null
  }
}

function channelToFreq(channel) {
  if (channel >= 1 && channel < 14) return channel * 5 + 2407
  else if (channel == 14) return 2484
  // assume these are 5G channels, channels under 30 are ignored
  else if (channel >= 30 && channel < 200) return channel * 5 + 5000
  else {
    log.error('Unknown channel', JSON.stringify(channel))
    return null
  }
}

function parseNumList(str) {
  const result = []
  for (const item of str.split(',')) {
    const bounds = item.split('-')
    if (bounds.length == 1)
      result.push(Number(bounds[0]))
    else {
      const lower = Number(bounds[0])
      const upper = Number(bounds[1])
      if (upper < lower) continue

      for (let num = lower; num <= upper; num++)
        result.push(num)
    }
  }

  return result.filter(n => !isNaN(n))
}

function generateUUID() {
  const ts = Date.now() + '';
  return uuid.v4().replace(/-/g,"").substring(ts.length) + ts;
}

/**
 * Generate a random MAC address with a three-byte prefix
 * @param {string} prefix - Three-byte MAC prefix (e.g., "00:11:22")
 * @returns {string} Random MAC address with the specified prefix
 */
function generateRandomMacAddress(prefix = "20:6D:31") {
  // Validate prefix format (should be 3 bytes in XX:XX:XX format)
  const prefixPattern = /^([0-9A-Fa-f]{2}):([0-9A-Fa-f]{2}):([0-9A-Fa-f]{2})$/;
  if (!prefixPattern.test(prefix)) {
    throw new Error('Invalid MAC prefix format. Expected format: XX:XX:XX');
  }

  // Generate 3 random bytes for the remaining part
  const randomBytes = [];
  for (let i = 0; i < 3; i++) {
    randomBytes.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  }

  // Combine prefix with random bytes
  const randomMac = `${prefix}:${randomBytes.join(':')}`;
  return randomMac.toUpperCase();
}

function isValidMacAddress(mac) {
  if (!mac || !_.isString(mac)) return false;
  return /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(mac);
}

// a caller supplied uuid is used verbatim in shell commands and config file paths, so callers
// need to reject a malformed one. validator throws on non-strings, hence the guard
function isValidUUID(id) {
  if (!id || !_.isString(id)) return false;
  return validator.isUUID(id);
}

// A dns name, optionally fully qualified, as dig prints it.
//
// Every label has to start and end alphanumeric. That is the hostname rule, and it is also what
// keeps a leading '-' out: these names are passed to dig as operands, and while execFile keeps them
// away from a shell it does not stop dig itself reading a value like "-felection" as an option.
// Rejecting a name here degrades gracefully - the caller falls back to a non-authoritative lookup.
const DNS_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const DNS_NAME_REGEX = new RegExp(`^(?=.{1,253}\\.?$)${DNS_LABEL}(?:\\.${DNS_LABEL})*\\.?$`);

function isValidDNSName(name) {
  if (!name || !_.isString(name)) return false;
  return DNS_NAME_REGEX.test(name);
}

/**
 * Coerce a config supplied value to an integer inside [min, max], or null if it is not one.
 *
 * The same value can arrive as a number or as a string depending on which producer wrote the
 * config, and it usually ends up interpolated into a shell command, so a bare Number() is not
 * enough - it lets NaN, floats, negatives and Infinity through. Callers that need setup and
 * teardown to agree on a value should both go through this.
 *
 * @param {*} value - the raw config value
 * @param {number} [min] - lowest accepted value, inclusive
 * @param {number} [max] - highest accepted value, inclusive
 * @returns {number|null} the integer, or null when the value is unusable
 */
function toBoundedInt(value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  // booleans and objects coerce to numbers in js, none of them are a config value we want
  if (!_.isNumber(value) && !_.isString(value)) return null;
  if (_.isString(value) && value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

module.exports = {
  extend: extend,
  delay: delay,
  wrapIptables: wrapIptables,
  getHexStrArray: getHexStrArray,
  generatePSK: generatePSK,
  generateWpaSupplicantConfig: generateWpaSupplicantConfig,
  generateUUID,
  generateRandomMacAddress,
  isValidMacAddress,
  isValidUUID,
  isValidDNSName,
  toBoundedInt,
  parseEscapedString,
  parseHexString,
  lastLine,
  freqToChannel,
  channelToFreq,
  parseNumList,
};
