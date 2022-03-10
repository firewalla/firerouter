#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"
LICENSE_FILE=/home/pi/.firewalla/license

source $DIR/../platform/platform.sh

run_host_light_until_paired() {
  type run_horse_light || return 1
  while [[ ! -e $LICENSE_FILE ]]; do
    run_horse_light 1 0
  done
}

run_host_light_until_paired &

# use this user firereset binary if configured, for debugging purpose only
USER_FIRERESET=/home/pi/.firewalla/run/firereset
if [[ -e $USER_FIRERESET ]]; then
  sudo BLE_IDLE_TIMEOUT=30 $USER_FIRERESET -timeout 3600
  exit 0
fi

FIRERESET_BINARY=$(get_firereset_path)
sudo BLE_IDLE_TIMEOUT=30 $FIRERESET_BINARY -timeout 3600
