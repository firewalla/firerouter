#!/bin/bash

source /home/pi/firerouter/platform/platform.sh
MSTPD_BINARY=$(get_mstpd_path)

exec "$MSTPD_BINARY" -d
