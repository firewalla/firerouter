#!/bin/bash

: ${FIREROUTER_HOME:=/home/pi/firerouter}

source ${FIREROUTER_HOME}/platform/platform.sh

# LAN interface
INTF=$1
MCPROXY_BINARY=$(get_mcproxy_path)

# mcproxy aborts if its startup MLD query has no usable source address, so wait for DAD to finish
for _ in {1..15}; do
  [ -z "$(ip -6 addr show dev "$INTF" tentative)" ] && break
  sleep 1
done

$MCPROXY_BINARY -f "/home/pi/.router/config/mcproxy/${INTF}.conf"
