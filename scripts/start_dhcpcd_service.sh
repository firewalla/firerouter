#!/bin/bash

: ${FIREROUTER_HOME:=/home/pi/firerouter}

source ${FIREROUTER_HOME}/platform/platform.sh

INTF=$1
DHCPCD_BINARY=$(get_dhcpcd_path)

$DHCPCD_BINARY -6 -t 0 -f "/home/pi/.router/config/dhcpcd6/${INTF}.conf" ${INTF} -e rt_tables="main ${INTF}_local ${INTF}_default" -e default_rt_tables="${INTF}_default" --duid-path "/home/pi/.router/run/dhcpcd-${INTF}.duid"