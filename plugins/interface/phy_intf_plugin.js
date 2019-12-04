'use strict';

const log = require('../../util/logger.js')(__filename);

const InterfaceBasePlugin = require('./intf_base_plugin.js');
const _ = require('lodash');

const fs = require('fs');
const Promise = require('bluebird');

Promise.promisifyAll(fs);


class PhyInterfacePlugin extends InterfaceBasePlugin {

}

module.exports = PhyInterfacePlugin;