#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

LISTEN_ADDRESSES=""

for CONF_FILE in /home/pi/.router/config/sshd/sshd_config.*; do
  [[ -f "$CONF_FILE" ]] && LISTEN_ADDRESSES="$LISTEN_ADDRESSES$(cat $CONF_FILE)\n"
done

sed "s/#LISTEN_ADDRESSES#/$LISTEN_ADDRESSES/g" $CUR_DIR/default_sshd_config > /home/pi/.router/config/sshd/sshd_config

# check if folder /home/pi/.router/config/sshd_config.d exists
if [ -d "/home/pi/.router/config/sshd_config.d" ]; then
  for EXTRA_CONF_FILE in /home/pi/.router/config/sshd_config.d/*.conf; do
     ## append a new line to the sshd_config file
    [[ -f "$EXTRA_CONF_FILE" ]] && echo "" >> /home/pi/.router/config/sshd/sshd_config && cat $EXTRA_CONF_FILE >> /home/pi/.router/config/sshd/sshd_config
  done
fi

sudo cp /home/pi/.router/config/sshd/sshd_config /etc/ssh/sshd_config

systemctl is-active ssh &>/dev/null || sudo systemctl start ssh
sudo systemctl reload sshd

