#!/bin/bash

NUM=1

if [[ -n $1 ]]; then
  NUM=$1
fi

test $NUM -gt 10 && exit 0

test $(redis-cli type sys:nobeep) != "none" && exit 0

sudo modprobe pcspkr
beep -r $NUM
sudo rmmod pcspkr
