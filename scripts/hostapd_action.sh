#!/bin/bash

#echo "$*" >> /home/pi/logs/hostapd_action.log
redis-cli -n 2 PUBLISH "hostapd.event" "$*"