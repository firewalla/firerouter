#!/bin/bash

: ${FIREROUTER_HOME:=/home/pi/firerouter}
source ${FIREROUTER_HOME}/platform/platform.sh

# firereset should never be stopped
${NEED_FIRESTATUS:=false} && curl 'http://127.0.0.1:9966/fire?name=firereset&type=critical_error'

exit 0
