#!/bin/bash

# This script will check if there is any upgrade available for firerouter
#

: ${FIREROUTER_HOME:=/home/pi/firerouter}

# Run upgrade
${FIREROUTER_HOME}/scripts/firerouter_upgrade.sh

# If upgrade complete, the file below should exist
if [[ -f /dev/shm/firerouter.upgraded ]]; then
  redis-cli set "fireboot:status" "firerouter_upgrade"
  echo "Restarting FireRouter ..."
  sudo systemctl restart firerouter
  init_network_config
  rm -f /dev/shm/firerouter.upgraded
  echo "Restarting FireReset ..."
  sudo systemctl restart firereset
fi



