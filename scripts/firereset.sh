#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"
LICENSE_FILE=/home/pi/.firewalla/license

source /home/pi/firewalla/platform/platform.sh
source $DIR/../platform/platform.sh

run_host_light_until_paired() {
  type run_horse_light || return 1
  while [[ ! -e $LICENSE_FILE ]]; do
    run_horse_light 1 0
  done
}

run_host_light_until_paired &

FIRERESET_BINARY=$(get_firereset_path)
sudo $FIRERESET_BINARY
