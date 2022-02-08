#!/usr/bin/env bash

test $(uname -m) != "x86_64" && exit 0

LICENSE_FILE=/home/pi/.firewalla/license

test -e $LICENSE_FILE && exit 0

check_ethtool() {
    pgrep -x ethtool &>/dev/null && return 1
    sleep 0.3
    pgrep -x ethtool &>/dev/null && return 1
    sleep 0.3
    pgrep -x ethtool &>/dev/null && return 1
    return 0
}

# exit if not exists
check_ethtool && exit 0

# double check
test -e $LICENSE_FILE && exit 0

# race condition probability is low
touch $LICENSE_FILE
sudo pkill -x ethtool

# harmless, no need to rm
#sleep 1
#test -s $LICENSE_FILE || rm $LICENSE_FILE
