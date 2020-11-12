#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"
LICENSE_FILE=/home/pi/.firewalla/license

source /home/pi/firewalla/platform/platform.sh
source $DIR/../platform/platform.sh

run_host_light_until_paired() {
  type run_horse_light || return 1
  while [[ ! -e $LICENSE_FILE ]]; do
    run_horse_light
  done
}

run_host_light_until_paired &

sudo $FW_PLATFORM_CUR_DIR/bin/firereset
