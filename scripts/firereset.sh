#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

source $DIR/../platform/platform.sh

sudo $FW_PLATFORM_CUR_DIR/bin/firereset