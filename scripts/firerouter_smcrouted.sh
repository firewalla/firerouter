#!/bin/bash

source /home/pi/firerouter/platform/platform.sh
SMCROUTED_BINARY=$(get_smcrouted_path)

$SMCROUTED_BINARY -f /home/pi/.router/config/smcroute/smcroute.conf