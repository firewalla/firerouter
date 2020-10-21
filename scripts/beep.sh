#!/bin/bash

# execute Firewalla beep.sh if any
FW_BEEP=/home/pi/firewalla/scripts/beep.sh
test -x $FW_BEEP && exec $FW_BEEP $@

NUM=${1:-'1'}

test $NUM -gt 10 && exit 0

if [[ $NUM -eq 1 ]]; then
    time_now=$(date +%s)
    time_bt=$(date -d "$(dmesg -T | sed -n '/ CSR8510 / s/\[\(.*\)\].*/\1/p'|tail -1)" +%s)
    let time_diff=time_now-time_bt
    # beep once only when bluetooth inserted within last 30 seconds
    test $time_diff -gt 30 && exit 1
fi

test $(redis-cli type sys:nobeep) != "none" && redis-cli del sys:nobeep && exit 0

sudo modprobe pcspkr
beep -r $NUM
sudo rmmod pcspkr
