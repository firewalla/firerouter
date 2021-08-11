#!/bin/bash

INTF=$1

case "$2" in
  CONNECTED)
    redis-cli publish "wpa.connected" "$INTF,$WPA_ID"
    ;;
  DISCONNECTED)
    redis-cli publish "wpa.disconnected" "$INTF,$WPA_ID"
    ;;
esac