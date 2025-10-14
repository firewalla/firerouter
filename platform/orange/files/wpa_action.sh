#!/bin/bash

IFACE="$WPA_INTERFACE"
EVENT="$WPA_EVENT"

logger "orange wpa_action.sh: $*, $IFACE, $EVENT, $WPA_ID"

INTF=$1

case "$2" in
  CONNECTED)
    redis-cli publish "wpa.connected" "$INTF,$WPA_ID"
    logger "orange wpa_action.sh: applying current config to apply latest $INTF sta connect event"
    curl -XPOST localhost:8837/v1/config/apply_current_config -o /dev/null || echo "Failed to apply current config to apply latest $INTF sta connect event"
    ;;
  DISCONNECTED)
    redis-cli publish "wpa.disconnected" "$INTF,$WPA_ID"
    ;;
esac