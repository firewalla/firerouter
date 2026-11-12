#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

# written by sshd_plugin.js from the per-interface sshd_config.* files, capped to what sshd can listen on
LISTEN_ADDRESSES=""
[[ -f /home/pi/.router/config/sshd/listen_addresses ]] && LISTEN_ADDRESSES="$(cat /home/pi/.router/config/sshd/listen_addresses)"

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

