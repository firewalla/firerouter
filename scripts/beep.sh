#!/bin/bash

NUM=1

if [[ -n $1 ]]; then
  NUM=$1
fi

test $(redis-cli type sys:nobeep) != "none" && exit 0

sudo modprobe pcspkr
beep -r $NUM
sudo rmmod pcspkr
