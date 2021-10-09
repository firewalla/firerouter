/*    Copyright 2021 Firewalla Inc
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

const r = require('./firerouter.js');
const fsp = require('fs').promises;

function getSavedFilePath(filename) {
  return `${r.getRuntimeFolder()}/files/${filename}`;
}

async function listSavedFileNames() {
  const files = await fsp.readdir(`${r.getRuntimeFolder()}/files/`);
  return files;
}

async function saveFile(filename, content) {
  await fsp.writeFile(getSavedFilePath(filename), content, {encoding: "utf8"});
}

async function loadFile(filename) {
  const content = await fsp.readFile(getSavedFilePath(filename), {encoding: "utf8"});
  return content;
}

async function removeFile(filename) {
  await fsp.unlink(getSavedFilePath(filename)).catch((err) => {});
}

module.exports = {
  getSavedFilePath,
  listSavedFileNames,
  saveFile,
  loadFile,
  removeFile
}