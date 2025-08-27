#!/bin/bash

FW_PLATFORM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

UNAME=$(uname -m)
NETWORK_SETUP=yes
BLUETOOTH_TIMEOUT=0

function run_horse_light {
  return
}

function get_pppoe_rps_cpus {
  echo "f"
}

function map_target_branch {
  echo $1
}

function led_report_network_down {
  return
}

function led_report_network_up {
  return
}

function get_node_modules_dir {
  echo "${FW_PLATFORM_CUR_DIR}/node_modules"
}

function get_dnsmasq_path {
  test -e /home/pi/.firewalla/run/dnsmasq && echo /home/pi/.firewalla/run/dnsmasq && return

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

function get_wpa_cli_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/wpa_cli"
}

function get_smcrouted_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/smcrouted"
}

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
      gold-se)
        source $FW_PLATFORM_DIR/gse/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/gse
        ;;
      purple-se)
        source $FW_PLATFORM_DIR/pse/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/pse
        ;;
      purple)
        source $FW_PLATFORM_DIR/purple/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/purple
        ;;
      orange)
        source $FW_PLATFORM_DIR/orange/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/orange
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
