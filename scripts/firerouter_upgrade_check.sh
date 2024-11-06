#!/bin/bash

# This script will check if there is any upgrade available for firerouter
#

err() {
  echo "ERROR: $@" >&2
}

# Single running instance ONLY
CMD=$(basename $0)
LOCK_FILE=/var/lock/${CMD/.sh/.lock}
exec {lock_fd}> $LOCK_FILE
flock -x -n $lock_fd || {
    err "Another instance of $CMD is already running, abort"
    exit 1
}
echo $$ > $LOCK_FILE

: ${FIREROUTER_HOME:=/home/pi/firerouter}

[ -s $FIREROUTER_HOME/scripts/firelog ] && FIRELOG=$FIREROUTER_HOME/scripts/firelog || FIRELOG=/usr/bin/logger

FRFLAG="/home/pi/.router/config/.no_upgrade_check"
if [[ -e $FRFLAG ]]; then
  $FIRELOG -t debug -m "FIREROUTER.UPGRADE.CHECK NO UPGRADE"
  echo "======= SKIP UPGRADING CHECK BECAUSE OF FLAG $FRFLAG ======="
  exit 0
fi

FIREROUTER_CANARY_SCRIPT="${FIREROUTER_HOME}/scripts/firerouter_upgrade_canary.sh"
FRCANARY_FLAG="/home/pi/.router/config/.no_upgrade_canary"

if [[ -e "$FIREROUTER_CANARY_SCRIPT" ]];then
  bash $FIREROUTER_CANARY_SCRIPT &> /tmp/firerouter_upgrade_canary.log
fi

if [[ -e $FRCANARY_FLAG ]]; then
  $FIRELOG -t debug -m "FIREROUTER.UPGRADE.CHECK NO CANARY UPGRADE"
  echo "======= SKIP FIREROUTER UPGRADING CHECK BECAUSE OF FLAG $FRCANARY_FLAG ======="
  exit 0
fi

source ${FIREROUTER_HOME}/bin/common
source ${FIREROUTER_HOME}/platform/platform.sh

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
