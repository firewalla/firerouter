#!/bin/bash

INTF=$1

source /home/pi/firerouter/platform/platform.sh

WPA_SUPPLICANT_BINARY=$(get_wpa_supplicant_path)
WPA_CLI_BINARY=$(get_wpa_cli_path)

$WPA_SUPPLICANT_BINARY -B -i $INTF -c /home/pi/.router/config/wpa_supplicant/$INTF.conf -P /home/pi/.router/run/wpa_supplicant/$INTF.pid
while true; do
  $WPA_CLI_BINARY -p /home/pi/.router/run/wpa_supplicant/$INTF/ -a /home/pi/firerouter/scripts/wpa_action.sh
  sleep 1
done