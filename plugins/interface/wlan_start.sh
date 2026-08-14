#!/bin/bash

: ${FIREROUTER_HOME:=/home/pi/firerouter}
: ${FIREROUTER_HIDDEN:=/home/pi/.router}
: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

# rsyslog
sudo cp -f $FIREROUTER_HOME/scripts/rsyslog.d/14-wpa_supplicant.conf /etc/rsyslog.d/
sudo cp -f $FIREROUTER_HOME/scripts/rsyslog.d/13-rtw.conf /etc/rsyslog.d/
sudo systemctl restart rsyslog

# logrotate
sudo cp -f $FIREROUTER_HOME/scripts/logrotate.d/wpa_supplicant /etc/logrotate.d/
sudo cp -f $FIREROUTER_HOME/scripts/logrotate.d/rtw /etc/logrotate.d/
# make crontab persistent, this depends on Firewalla code, but that's fine cuz
# update_crontab.sh exists in both Gold and Purple's base image, and covers ~/.firewalla/config/crontab/
mkdir -p $FIREWALLA_HIDDEN/config/crontab
echo "*/10 * * * * sudo logrotate /etc/logrotate.d/rtw" > $FIREWALLA_HIDDEN/config/crontab/rtw-logrotate
$FIREWALLA_HOME/scripts/update_crontab.sh || true

# mkdir
mkdir -p $FIREROUTER_HIDDEN/config/wpa_supplicant
mkdir -p $FIREROUTER_HIDDEN/run/wpa_supplicant
mkdir -p $FIREROUTER_HIDDEN/tmp

cp $FIREROUTER_HOME/scripts/wpa_supplicant.sh $FIREROUTER_HIDDEN/tmp/wpa_supplicant.sh

# install service
sed "s|%WPA_SUPPLICANT_DIRECTORY%|$FIREROUTER_HIDDEN/tmp|g" $FIREROUTER_HOME/scripts/firerouter_wpa_supplicant@.template.service > $FIREROUTER_HIDDEN/tmp/firerouter_wpa_supplicant@.service
sudo cp $FIREROUTER_HIDDEN/tmp/firerouter_wpa_supplicant@.service /etc/systemd/system
sudo systemctl daemon-reload
