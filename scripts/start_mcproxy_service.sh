#!/bin/bash

: ${FIREROUTER_HOME:=/home/pi/firerouter}

source ${FIREROUTER_HOME}/platform/platform.sh

# LAN interface
INTF=$1
MCPROXY_BINARY=$(get_mcproxy_path)

$MCPROXY_BINARY -f "/home/pi/.router/config/mcproxy/${INTF}.conf"
