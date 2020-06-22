#!/bin/bash

FW_PLATFORM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

UNAME=$(uname -m)
NETWORK_SETUP=yes

case "$UNAME" in
"x86_64")
  source $FW_PLATFORM_DIR/$GOLD/platform.sh
  FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/gold
  ;;
"aarch64")
  source $FW_PLATFORM_DIR/navy/platform.sh
  FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/navy
  ;;
*)
  ;;
esac
