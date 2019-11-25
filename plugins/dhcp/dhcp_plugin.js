'use strict';

const log = require('../../util/logger.js')(__filename);

const Plugin = require('../plugin.js');

const dhcpServiceFileTemplate = __dirname + "/firerouter_dhcp.template.service";
const dhcpScriptTemplate = __dirname + "/dhcp.template.sh";

const exec = require('child-process-promise').exec;

const r = require('../../util/firerouter');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

class DHCPPlugin extends Plugin {
  init(config) {
    super.init(config);
  }

  async installSystemService() {
    let content = await fs.readFileAsync(dhcpServiceFileTemplate, {encoding: 'utf8'});
    content = content.replace("%WORKING_DIRECTORY%", r.getFireRouterHome());
    content = content.replace("%DHCP_DIRECTORY%", r.getTempFolder());
    const targetFile = r.getTempFolder() + "/firerouter_dhcp.service";
    await fs.writeFileAsync(targetFile, content);
    await exec(`sudo cp ${targetFile} /etc/systemd/system`);
    await exec("sudo systemctl daemon-reload");
  }

  async installDHCPScript() {
    let content = await fs.readFileAsync(dhcpScriptTemplate, {encoding: 'utf8'});
    content = content.replace("%FIREROUTER_HOME%", r.getFireRouterHome());
    content = content.replace("%FIREROUTER_HOME%", r.getFireRouterHome());
    const targetFile = r.getTempFolder() + "/dhcp.sh";
    await fs.writeFileAsync(targetFile, content);
  }

  async run(name, networkConfig) {
    await this.installDHCPScript();
    await this.installSystemService();
    await exec("sudo systemctl restart firerouter_dhcp");
  }
}

module.exports = DHCPPlugin;