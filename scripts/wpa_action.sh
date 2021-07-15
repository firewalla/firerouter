#!/bin/bash

INTF=$1

case "$2" in
  CONNECTED)
    redis-cli publish "wpa.connected" "$INTF"
    ;;
  DISCONNECTED)
    redis-cli publish "wpa.disconnected" "$INTF"
    ;;
esac