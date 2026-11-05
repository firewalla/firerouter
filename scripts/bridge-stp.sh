#!/bin/bash
source /home/pi/firerouter/platform/platform.sh
MSTPCTL=$(get_mstpctl_path)
case "$2" in
    start) "$MSTPCTL" addbridge "$1" && exit 0 ;;
    stop)  "$MSTPCTL" delbridge "$1" && exit 0 ;;
esac
exit 1
