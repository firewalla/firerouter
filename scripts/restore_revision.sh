#!/bin/bash

set -e

: ${FIREROUTER_HOME:=/home/pi/firerouter}
MGIT=$(PATH=/home/pi/scripts:$FIREROUTER_HOME/scripts; /usr/bin/which mgit||echo git)
CMD=$(basename $0)

usage() {
    cat <<EOU
usage: $CMD <revision>
example:
    $CMD 94368757147931d07a40d13b224615e44a5a943d
EOU
}

err() {
    msg="$@"
    echo "ERROR: $msg" >&2
}

restore_revision() {
  target_revision=$1

  ( cd $FIREROUTER_HOME
  $MGIT reset --hard $target_revision
  )
}

# --------------
# MAIN goes here
# --------------

test $# -gt 0 || {
    usage
    err "revision is required"
    exit 1
}

revision=$1
restore_revision $revision || exit 1

sync
logger "FIREROUTER: RESTORE TO REVISION $revision"
