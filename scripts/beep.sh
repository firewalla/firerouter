#!/bin/bash

# execute Firewalla beep.sh if any
FW_BEEP=/home/pi/firewalla/scripts/beep.sh
test -x $FW_BEEP && exec $FW_BEEP $@

NUM=${1:-'1'}

test $NUM -gt 10 && exit 0

if [[ $NUM -eq 1 ]]; then
    dmesg | tail -n 10 | fgrep -q CSR8510 || exit 1
fi

test $(redis-cli type sys:nobeep) != "none" && redis-cli del sys:nobeep && exit 0

sudo modprobe pcspkr
beep -r $NUM
sudo rmmod pcspkr
