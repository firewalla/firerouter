/*    Copyright 2019-2021 Firewalla Inc.
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

const express = require('express');
const router = express.Router();
const bodyParser = require('body-parser');
const log = require('../../util/logger.js')(__filename);
const ncm = require('../../core/network_config_mgr.js');
const ns = require('../../core/network_setup.js');


const WLAN_FLAG_WEP         = 0b1
const WLAN_FLAG_WPA         = 0b10
const WLAN_FLAG_WPA2        = 0b100
const WLAN_FLAG_PSK         = 0b1000
const WLAN_FLAG_EAP         = 0b10000
const WLAN_FLAG_SAE         = 0b100000
const WLAN_FLAG_PSK_SHA256  = 0b1000000
const WLAN_FLAG_EAP_SHA256  = 0b10000000


const _ = require('lodash');
const { exec } = require('child-process-promise');
let transactionTask = null;
let inTransaction = false;
let currentTransID = null;

const T_OP_APPEND = "append";
const T_OP_COMMIT = "commit";
const T_OP_REVERT = "revert";
const validTransactionOps = [T_OP_APPEND, T_OP_COMMIT, T_OP_REVERT];
const T_REVERT_TIMEOUT = 120 * 1000; // revert back to previous persisted config in 2 minutes

const assetsController = require('../../core/assets_controller.js');

router.get('/active', async (req, res, next) => {
  const config = await ncm.getActiveConfig(inTransaction);
  if(config) {
    res.json(config);
  } else {
    res.status(404).send('');
  }
});

router.get('/wans', async (req, res, next) => {
  await ncm.getWANs().then((wans) => {
    res.status(200).json(wans);
  }).catch((err) => {
    log.error(req.url, err)
    res.status(500).json({errors: [err.message]});
  });
});

router.get('/lans', async (req, res, next) => {
  await ncm.getLANs().then((lans) => {
    res.status(200).json(lans);
  }).catch((err) => {
    log.error(req.url, err)
    res.status(500).json({errors: [err.message]});
  });
});

router.get('/wlan/:intf/available', async (req, res, _next) => {
  try {
    const detailed = await ncm.getWlansViaWpaSupplicant(Number(req.query.waitForScan))
    log.debug(`Got ${detailed.length} SSIDs from wpa_supplicant`)
    const result = detailed
      .filter(w => w.ssid != '')
      .sort( (a, b) => b.signal - a.signal )
      // combine same ssid
      .reduce( (prev, curr) => {
        const wlan = prev.find(e => e.ssid == curr.ssid)
        if (wlan) wlan.flags = _.union(wlan.flags, curr.flags)
        else prev.push(_.pick(curr, 'ssid', 'signal', 'flags'))
        return prev
      }, [])
      // map result to a compact array
      .map(w => {
        const result = [ w.ssid, w.signal ]
        const flags = w.flags.map(f => {
          let bitFlag = 0
          const split = f.split(/[+-]/)
          switch (split[0]) {
            case 'WEP':
              bitFlag |= WLAN_FLAG_WEP
              break
            case 'EAP': // EAP without WPA
              bitFlag |= WLAN_FLAG_EAP
              break
            case 'WPA':
              bitFlag |= WLAN_FLAG_WPA
              break
            case 'RSN':
            case 'WPA2':
              bitFlag |= WLAN_FLAG_WPA2
              break
          }

          let i = 1
          while (i < split.length) {
            switch (split[i++]) {
              case 'PSK':
                if (split[i] == 'SHA256') {
                  bitFlag |= WLAN_FLAG_PSK_SHA256
                  i ++
                } else
                  bitFlag |= WLAN_FLAG_PSK
                break
              case 'EAP':
                if (split[i] == 'SHA256') {
                  bitFlag |= WLAN_FLAG_EAP_SHA256
                  i ++
                } else
                  bitFlag |= WLAN_FLAG_EAP
                break
              case 'SAE':
                bitFlag |= WLAN_FLAG_SAE
                break
            }
          }

          return bitFlag
        }).filter(Boolean)

        if (flags.length) result.push(flags)

        return result
      })
    res.status(200).json(result)
  } catch(err) {
    log.error(req.url, err)
    res.status(500).json({errors: [err.message]});
  }
});

router.get('/wlan/:intf/channels', async (req, res, _next) => {
  try {
    const channels = await ncm.getAvailableChannelsHostapd()
    res.status(200).json(channels)
  } catch(err) {
    log.error(req.url, err)
    res.status(500).json({errors: [err.message]});
  }
});

const jsonParser = bodyParser.json();

router.post('/wan/:intf/connectivity', jsonParser, async (req, res, next) => {
  await ncm.checkWanConnectivity(req.params.intf, req.body).then((result) => {
    res.status(200).json(result);
  }).catch((err) => {
    log.error(req.url, err)
    res.status(500).json({errors: [err.message]});
  });
});

router.get('/wan/connectivity', async (req, res, next) => {
  try {
    const options = {live: req.query.live === "true" || false};
    const status = await ncm.isAnyWanConnected(options);
    res.status(200).json(status);
  } catch(err) {
    res.status(500).json({errors: [err.message]});
  }
});

router.post('/wlan/switch_wifi/:intf',
  jsonParser,
  async (req, res, next) => {
    const intf = req.params.intf;
    const config = req.body;
    if (!config || !config.ssid) {
      res.status(400).json({errors: ['"ssid" is not specified.']});
      return;
    }
    const errors = await ncm.switchWifi(intf, config.ssid, config.params, config.testOnly).catch((err) => [err.message]);
    if (errors && errors.length != 0) {
      log.error(`Failed to switch to ssid ${config.ssid} on ${intf}`, errors);
      res.status(400).json({errors: errors});
    } else {
      log.info(`Successfully switched to ssid ${config.ssid} on ${intf}`, errors);
      res.status(200).json({errors: []});
    }
  });

router.get('/phy_interfaces', async (req, res, next) => {
  await ncm.getPhyInterfaceNames().then((intfs) => {
    res.status(200).json({intfs: intfs});
  }).catch((err) => {
    res.status(500).json({errors: [err.message]});
  });
});

router.get('/phy_interfaces/state/simple', async (req, res, next) => {
  try {
    const intfs = await ncm.getPhyInterfaceNames()
    const result = {}
    for (const intf of intfs) {
      result[intf] = await ncm.getInterfaceSimple(intf)
    }
    res.status(200).json(result);
  } catch(err) {
    log.error(req.url, err)
    res.status(500).json({errors: [err.message]});
  }
});

router.get('/interfaces/:intf', async (req, res, next) => {
  const intf = req.params.intf;
  await ncm.getInterface(intf).then((result) => {
    if (result) {
      res.status(200).json(result);
    } else {
      res.status(404).send('');
    }
  }).catch((err) => {
    log.error(req.url, err)
    res.status(500).json({errors: [err.message]});
  });
});

router.get('/interfaces', async (req, res, next) => {
  await ncm.getInterfaces().then((result) => {
    if (result) {
      res.status(200).json(result);
    } else {
      res.status(404).send('');
    }
  }).catch((err) => {
    log.error(req.url, err)
    res.status(500).json({errors: [err.message]});
  })
});

router.post('/set',
  jsonParser,
  async (req, res, next) => {
    let newConfig = req.body;
    const transactionOp = newConfig.transactionOp;
    const transID = newConfig.transID;
    delete newConfig.transactionOp; // do not leave transactionOp in the saved config
    delete newConfig.transID;
    if (transactionOp && !validTransactionOps.includes(transactionOp)) {
      const errMsg = `Unrecognized transactionOp in config: ${transactionOp}`;
      log.error(errMsg);
      res.status(400).json({errors:[errMsg]});
    }
    if (inTransaction && !validTransactionOps.includes(transactionOp)) {
      const errMsg = "A config change transaction context is in progress, reject non-transaction change request";
      log.error(errMsg);
      res.status(400).json({errors:[errMsg]});
      return;
    }
    if (!inTransaction && (transactionOp === T_OP_COMMIT || transactionOp === T_OP_REVERT)) {
      const errMsg = "No ongoing config change transaction context, cannot commit or revert";
      log.error(errMsg);
      res.status(400).json({errors: [errMsg]});
      return;
    }
    if (validTransactionOps.includes(transactionOp) && _.isEmpty(transID)) {
      const errMsg = `transID is not defined in transactional network config change request`;
      log.error(errMsg);
      res.status(400).json({errors: [errMsg]});
      return;
    }
    if (inTransaction && (_.isEmpty(transID) || transID !== currentTransID)) {
      const errMsg = `transID ${transID} does not match current transaction ID`;
      log.error(errMsg);
      res.status(400).json({errors: [errMsg]});
      return;
    }
    if (inTransaction) {
      switch (transactionOp) {
        case T_OP_COMMIT:
          newConfig = await ncm.getActiveConfig(true);
          await ncm.saveConfig(newConfig, false); // save transaction config to persisted config
          if (transactionTask)
            clearTimeout(transactionTask)
          inTransaction = false;
          currentTransID = null;
          log.info("Commit config change transaction: " + JSON.stringify(newConfig));
          res.status(200).json({errors: []});
          return;
        case T_OP_REVERT:
          // previous persisted config will be applied in the code below
          newConfig = await ncm.getActiveConfig(false);
          log.info("Manually revert back to previous persisted config: " + JSON.stringify(newConfig));
          if (transactionTask)
            clearTimeout(transactionTask);
          inTransaction = false;
          currentTransID = null;
          break;
        default:
      }
    }
    let errors = await ncm.validateConfig(newConfig);
    if (errors && errors.length != 0) {
      log.error("Invalid network config", errors);
      res.json({errors: errors});
    } else {
      errors = await ncm.tryApplyConfigWithRWLock(newConfig);
      if (errors && errors.length != 0) {
        log.error("Failed to apply new network config", errors);
        res.status(400).json({errors: errors});
      } else {
        log.info("New config is applied with no error");
        if (transactionOp === T_OP_APPEND) {
          log.info("in transaction context now");
          inTransaction = true;
          currentTransID = transID;
          // create or extend the timeout task
          if (transactionTask)
            clearTimeout(transactionTask);
          transactionTask = setTimeout(async () => {
            const oldConfig = await ncm.getActiveConfig(false);
            log.info("Automatically revert back to previous persisted config: " + JSON.stringify(oldConfig));
            await ncm.tryApplyConfigWithRWLock(oldConfig).catch((err) => {
              log.error(`Failed to automatically revert to old config`, err.message);
            });
            transactionTask = null;
            inTransaction = false;
            currentTransID = null;
          }, T_REVERT_TIMEOUT);
        }
        await ncm.saveConfig(newConfig, inTransaction);
        res.status(200).json({errors: errors});
      }
    }
  });

router.post('/prepare_env',
  jsonParser,
  async (req, res, next) => {
    await ns.prepareEnvironment().then(() => {
      res.status(200).json({errors: []});
    }).catch((err) => {
      log.error(req.url, err)
      res.status(500).json({errors: [err.message]});
    })
  })

router.post('/apply_current_config',
  jsonParser,
  async (req, res, next) => {
    const currentConfig = await ncm.getActiveConfig(inTransaction);
    if (currentConfig) {
      let errors = await ncm.validateConfig(currentConfig);
      if (errors && errors.length != 0) {
        log.error("Invalid network config", errors);
        res.json({errors: errors});
      } else {
        errors = await ncm.tryApplyConfig(currentConfig);
        if (errors && errors.length != 0) {
          log.error("Failed to apply current network config", errors);
          res.status(400).json({errors: errors});
        } else {
          log.info("Current config is applied with no error");
          await ncm.saveConfig(currentConfig);
          res.status(200).json({errors: errors});
        }
      }
    } else {
      res.status(404).send("Network config is not set.");
    }
  });

router.post('/renew_dhcp_lease',
  jsonParser,
  async (req, res, next) => {
    const intf = req.body.intf;
    if (!intf) {
      res.status(400).json({errors: ['"intf" is not specified']});
      return;
    }
    const prev = await ncm.getDHCPLease(intf).catch((err) => null);
    if (prev && prev.ts && Date.now() / 1000 - prev.ts < 60) {
      // directly return previous lease info if renew interval is less than 60 seconds
      res.status(200).json({errors: [], info: prev});
      return;
    }
    await ncm.renewDHCPLease(intf).then((info) => {
      if (info)
        res.status(200).json({errors: [], info});
      else
        res.status(500).json({errors: [`Failed to renew DHCP lease on ${intf}`]});
    }).catch((err) => {
      res.status(400).json({errors: [err.message]});
    });
  });

router.get('/dhcp_lease/:intf', async (req, res, next) => {
    const intf = req.params.intf;
    if (!intf) {
      res.status(400).json({errors: ['"intf" is not specified']});
      return;
    }
    await ncm.getDHCPLease(intf).then((info) => {
      if (info)
        res.status(200).json({errors: [], info});
      else
        res.status(500).json({errors: [`Failed to get DHCP lease on ${intf}`]});
    }).catch((err) => {
      res.status(400).json({errors: [err.message]});
    });
  })
  
module.exports = router;
