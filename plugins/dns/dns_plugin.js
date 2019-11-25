'use strict';

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');

const dnsServiceFileTemplate = __dirname + "/firerouter_dns.template.service";
const dnsScriptTemplate = __dirname + "/dns.template.sh";

const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

class DNSPlugin extends Plugin {
  init(config) {
    super.init(config);
  }

  async installSystemService() {
    let content = await fs.readFileAsync(dnsServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace("%WORKING_DIRECTORY%", r.getFireRouterHome());
    content = content.replace("%DNS_DIRECTORY%", r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_dns.service";
    await fs.writeFileAsync(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);
    await exec("sudo systemctl daemon-reload");
  }

  async installDNSScript() {
    let content = await fs.readFileAsync(dnsScriptTemplate, {encoding: 'utf8'});
    content = content.replace("%FIREROUTER_HOME%", r.getFireRouterHome());
    content = content.replace("%FIREROUTER_HOME%", r.getFireRouterHome());
    const targetFile = r.getTempFolder() + "/dns.sh";
    await fs.writeFileAsync(targetFile, content);
  }

  async run(name, networkConfig) {
    await this.installDNSScript();
    await this.installSystemService();
    await exec("sudo systemctl restart firerouter_dns");
  }
}

module.exports = DNSPlugin;