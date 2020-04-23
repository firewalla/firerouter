
#!/bin/bash

# This script will check if there is any upgrade available for firerouter
#

: ${FIREROUTER_HOME:=/home/pi/firerouter}

source ${FIREROUTER_HOME}/bin/common

# Run upgrade
${FIREROUTER_HOME}/scripts/firerouter_upgrade.sh

# If upgrade complete, the file below should exist
if [[ -f /dev/shm/firerouter.upgraded ]]; then
  # this will disable beep in beep.sh
  redis-cli set sys:nobeep 1
  redis-cli set "fireboot:status" "firerouter_upgrade"
  # need to redo prepare network if firerouter is upgraded
  rm -f /dev/shm/firerouter.prepared
  echo "Restarting FireRouter ..."
  sudo systemctl restart firerouter
  init_network_config
  rm -f /dev/shm/firerouter.upgraded
  echo "Restarting FireReset ..."
  sudo systemctl restart firereset
fi



