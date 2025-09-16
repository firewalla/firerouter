#!/bin/bash

INTF=$1

source /home/pi/firerouter/platform/platform.sh

HOSTAPD_BINARY=$(get_hostapd_path)

sudo $HOSTAPD_BINARY /home/pi/.router/config/hostapd/$INTF.conf