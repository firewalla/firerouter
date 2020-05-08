#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

LISTEN_ADDRESSES=""

for CONF_FILE in /home/pi/.router/config/sshd/sshd_config.*; do
  [[ -f "$CONF_FILE" ]] && LISTEN_ADDRESSES="$LISTEN_ADDRESSES$(cat $CONF_FILE)\n"
done

sed "s/#LISTEN_ADDRESSES#/$LISTEN_ADDRESSES/g" $CUR_DIR/default_sshd_config > /home/pi/.router/config/sshd/sshd_config

sudo cp /home/pi/.router/config/sshd/sshd_config /etc/ssh/sshd_config

sudo systemctl reload sshd

