#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

ENABLED_INTERFACES=""

for CONF_FILE in /home/pi/.router/config/mdns_reflector/mdns_reflector.*; do
  [[ -f "$CONF_FILE" ]] && ENABLED_INTERFACES="$(cat $CONF_FILE),$ENABLED_INTERFACES"
done

sed "s/#ENABLED_INTERFACES#/$ENABLED_INTERFACES/g" $CUR_DIR/default_avahi_daemon_config > /home/pi/.router/config/mdns_reflector/avahi-daemon.conf

sudo cp /home/pi/.router/config/mdns_reflector/avahi-daemon.conf /etc/avahi/avahi-daemon.conf

if [[ -n $ENABLED_INTERFACES ]]; then
  sudo systemctl restart avahi-daemon
else
  sudo systemctl stop avahi-daemon
fi