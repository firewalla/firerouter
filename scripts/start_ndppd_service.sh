#!/bin/bash

: ${FIREROUTER_HOME:=/home/pi/firerouter}

source ${FIREROUTER_HOME}/platform/platform.sh

# LAN infterface
INTF=$1
NDPPD_BINARY=$(get_ndppd_path)

$NDPPD_BINARY -c "/home/pi/.router/config/ndppd/${INTF}.conf"
