#!/bin/bash

INTF=$1

source /home/pi/firerouter/platform/platform.sh

HOSTAPD_CLI_BINARY=$(get_hostapd_cli_path)

if [ -z "$HOSTAPD_CLI_BINARY" ]; then
  echo "HOSTAPD_CLI_BINARY is not set"
  exit 1
fi

if [ ! -f "$HOSTAPD_CLI_BINARY" ]; then
  echo "HOSTAPD_CLI_BINARY not found: $HOSTAPD_CLI_BINARY"
  exit 1
fi

if [ ! -f "/home/pi/firerouter/scripts/hostapd_action.sh" ]; then
  echo "hostapd_action.sh not found"
  exit 1
fi

while true; do
  if sudo $HOSTAPD_CLI_BINARY -p /home/pi/.router/run/hostapd -i $INTF -a /home/pi/firerouter/scripts/hostapd_action.sh; then
    echo "hostapd_cli disconnected, reconnecting in 1 second..."
    sleep 1
  else
    echo "hostapd_cli connection failed, retrying in 5 seconds..."
    sleep 5
  fi
done