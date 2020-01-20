/*    Copyright 2019 Firewalla Inc
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
const log = require("./logger.js")(__filename)

const cp = require('child_process');
const exec = require('child-process-promise').exec;
const util = require('util');

// TODO: Read this from config file
const home = process.env.FIREROUTER_HOME || "/home/pi/firerouter"
let _isProduction = null;
let _isDocker = null;
let _platform = null;
let _isOverlayFS = null;
let _branch = null
let _lastCommitDate = null

let version = null;
let latestCommitHash = null;

function getFireRouterHome() {
  return home;
}

function getBranch() {
  if(_branch == null) {
    _branch = cp.execSync("git rev-parse --abbrev-ref HEAD", {encoding: 'utf8'}).replace(/\n/g, "")
  }
  return _branch
}

function getLastCommitDate() {
  if(_lastCommitDate == null) {
    _lastCommitDate = Number(cp.execSync("git show -s --format=%ct HEAD", {encoding: 'utf8'}).replace("\n", ""))
  }
  return _lastCommitDate
}

async function getProdBranch() {
  let branch = await rclient.hgetAsync("sys:config", "prod.branch")
  if(branch) {
    return branch
  } else {
    return "release_6_0" // default
  }
}

function getUserID() {
  return process.env.USER;
}

function getUserHome() {
  return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

function getLogFolder() {
  return getUserHome() + "/.forever";
}

function getHiddenFolder() {
  return getUserHome() + "/.router";
}

function getFirewallaHiddenFolder() {
  return getUserHome() +  "/.firewalla";
}

function isDevelopmentVersion() {
  let branch = getBranch();
  if(branch === "master" || branch.includes("master")) {
    return true
  } else {
    return false
  }
}

function isBeta() {
  const branch = getBranch()
  if(branch.match(/^beta_.*/)) {
    return true;
  } else {
    return false
  }
}

function isAlpha() {
  const branch = getBranch();
  return !!branch.match(/^alpha_.*/);
}

function isProduction() {
  const branch = getBranch();
  return !!branch.match(/^release_.*/);
}

function isProductionOrBeta() {
  return isProduction() || isBeta()
}

function isProductionOrBetaOrAlpha() {
  return isProduction() || isBeta() || isAlpha()
}


function getReleaseType() {
  if(isProduction()) {
    return "prod"
  } else if(isAlpha()) {
    return "alpha";
  } else if(isBeta()) {
    return "beta"
  } else if (isDevelopmentVersion()) {
    return "dev"
  } else {
    return "unknown"
  }
}

function getUserConfigFolder() {
  return getHiddenFolder() + "/config";
}

function getTempFolder() {
  return getHiddenFolder() + "/tmp";
}

function getRuntimeFolder() {
  return getHiddenFolder() + "/run";
}

function getFirewallaUserConfigFolder() {
  return getFirewallaHiddenFolder() + "/config";
}

function getInterfaceResolvConfPath(iface) {
  return `${getRuntimeFolder()}/${iface}.resolv.conf`;
}

function getVersion() {
  if(!version) {
    let cmd = "git describe --tags";
    let versionElements = [];

    try {
      versionElements = cp.execSync(cmd).toString('utf-8')
        .replace(/\n$/, '').split("-");
    } catch (err) {
      log.error("Failed to get git version tags", err);
    }

    if(versionElements.length === 3) {
      version = util.format("%s.%s (%s)", versionElements[0], versionElements[1], versionElements[2]);
    } else if(versionElements.length === 1) {
      version = util.format("%s.0 (0)", versionElements[0])
    } else {
      version = "0.0 (0)";
    }
  }

  return version;
}

function getLatestCommitHash() {
  if(!latestCommitHash) {
    const cmd = "git rev-parse HEAD"

    try {
      latestCommitHash = cp.execSync(cmd).toString('utf-8')
        .replace(/\n$/, '').substring(0, 8);
    } catch (err) {
      log.error("Failed to get latest commit hash", err);
    }
  }

  return latestCommitHash;
}

function getProcessName() {
  return process.title;
}

async function switchBranch(targetBranch) {
  await exec(`${getFireRouterHome()}/scripts/switch_branch.sh ${targetBranch}`);
  scheduleRestartFireBoot();
}

function scheduleRestartFireBoot(delay = 10) {
  setTimeout(() => {
    exec(`sudo systemctl restart fireboot`);
  }, delay * 1000);
}

module.exports = {
  getUserHome: getUserHome,
  getHiddenFolder: getHiddenFolder,
  getLogFolder: getLogFolder,
  getUserConfigFolder: getUserConfigFolder,
  getUserID: getUserID,
  getVersion: getVersion,
  getBranch:getBranch,
  getTempFolder: getTempFolder,
  getRuntimeFolder: getRuntimeFolder,
  isProduction: isProduction,
  isBeta:isBeta,
  isAlpha: isAlpha,
  isDevelopmentVersion:isDevelopmentVersion,
  isProductionOrBeta:isProductionOrBeta,
  isProductionOrBetaOrAlpha:isProductionOrBetaOrAlpha,
  getProdBranch: getProdBranch,
  getReleaseType: getReleaseType,
  getLastCommitDate:getLastCommitDate,
  getProcessName:getProcessName,
  getLatestCommitHash:getLatestCommitHash,
  getFireRouterHome:getFireRouterHome,
  getFirewallaUserConfigFolder: getFirewallaUserConfigFolder,
  getInterfaceResolvConfPath: getInterfaceResolvConfPath,
  switchBranch: switchBranch
};
