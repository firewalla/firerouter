#!/bin/bash

FW_PLATFORM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

UNAME=$(uname -m)
NETWORK_SETUP=yes

case "$UNAME" in
  "x86_64")
    source $FW_PLATFORM_DIR/gold/platform.sh
    FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/gold
    ;;
  "aarch64")
    if [[ -e /etc/firewalla-release ]]; then
      BOARD=$( . /etc/firewalla-release 2>/dev/null && echo $BOARD || cat /etc/firewalla-release )
    else
      BOARD='unknown'
    fi
    case $BOARD in
      navy)
        source $FW_PLATFORM_DIR/navy/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/navy
        ;;
      purple)
        source $FW_PLATFORM_DIR/purple/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/purple
        ;;
      *)
        unset FW_PLATFORM_CUR_DIR
        ;;
    esac
    ;;
  *)
    ;;
esac

export DP_SO_PATH="$FW_PLATFORM_CUR_DIR/bin/libdnsproxy.so"

function get_node_modules_dir {
  echo "${FW_PLATFORM_CUR_DIR}/node_modules"
}

function get_dnsmasq_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/dnsmasq"
}

function get_firereset_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/firereset"
}

function get_hostapd_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/hostapd"
}

function get_wpa_supplicant_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/wpa_supplicant"
}

function get_pppoe_rps_cpus {
  echo "f"
}
