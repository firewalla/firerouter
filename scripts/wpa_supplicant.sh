#!/bin/bash

INTF=$1

source /home/pi/firerouter/platform/platform.sh

WPA_SUPPLICANT_BINARY=$(get_wpa_supplicant_path)

sudo $WPA_SUPPLICANT_BINARY -B -i $INTF -c /home/pi/.router/config/wpa_supplicant/$INTF.conf -P /home/pi/.router/run/wpa_supplicant/$INTF.pid