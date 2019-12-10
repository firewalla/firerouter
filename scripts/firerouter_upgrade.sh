#!/bin/bash

#
#    Copyright 2017 Firewalla LLC
#
#    This program is free software: you can redistribute it and/or  modify
#    it under the terms of the GNU Affero General Public License, version 3,
#    as published by the Free Software Foundation.
#
#    This program is distributed in the hope that it will be useful,
#    but WITHOUT ANY WARRANTY; without even the implied warranty of
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#    GNU Affero General Public License for more details.
#
#    You should have received a copy of the GNU Affero General Public License
#    along with this program.  If not, see <http://www.gnu.org/licenses/>.
#

# This script should only handle upgrade, nothing else
#
# WARNING:  EXTRA CARE NEEDED FOR THIS SCRIPT!  ANYTHING BROKEN HERE
# WILL PREVENT UPGRADES!

# timeout_check - timeout control given process or last background process
# returns:
#   0 - process exits before timeout
#   1 - process killed due to timeout

: ${FIREROUTER_HOME:=/home/pi/firerouter}
MGIT=$(PATH=/home/pi/scripts:$FIREROUTER_HOME/scripts; /usr/bin/which mgit||echo git)

# ensure that run directory already exists
mkdir -p /home/pi/.firewalla/run

mode=${1:-'normal'}

timeout_check() {
    pid=${1:-$!}
    timeout=${2:-120}
    interval=${3:-1}
    delay=${4:-3}
    while (( timeout>0 ))
    do
        sleep $interval
        (( timeout-=$interval ))
        sudo kill -0 $pid || return 0
    done

    sudo kill -s TERM $pid
    sleep $delay
    sudo kill -0 $pid || return 1
    if sudo kill -0 $pid
    then
        sudo kill -s SIGKILL $pid
    fi
    return 1
}

/home/pi/firerouter/scripts/firelog -t local -m "FIREROUTER.UPGRADE($mode) Starting FIRST "+`date`

TIME_THRESHOLD="2019-10-14"

function sync_time() {
    time_website=$1
    time=$(curl -D - ${time_website} -o /dev/null --silent | awk -F ": " '/^Date: / {print $2}')
    if [[ "x$time" == "x" ]]; then
        logger "ERROR: Failed to load date info from website: $time_website"
        return 1
    else
        # compare website time against threshold to prevent it goes bad in some rare cases
        tsWebsite=$(date -d "$time" +%s)
        tsThreshold=$(date -d "$TIME_THRESHOLD" +%s)
        if [ $tsWebsite -ge $tsThreshold ];
        then
          sudo date -s "$time";
        else
          return 1
        fi
    fi
}

logger "FIREROUTER.UPGRADE.DATE.SYNC"
sync_time status.github.com || sync_time google.com || sync_time live.com || sync_time facebook.com
ret=$?
if [[ $ret -ne 0 ]]; then
    sudo systemctl stop ntp
    sudo date -s "$TIME_THRESHOLD" # set minimal date here to prevent SSL failure on undergoing HTTPS calls
    sudo timeout 30 ntpd -gq || sudo ntpdate -b -u -s time.nist.gov
    sudo systemctl start ntp
fi
logger "FIREROUTER.UPGRADE.DATE.SYNC.DONE"
sync

GITHUB_STATUS_API=https://api.github.com

logger `date`
rc=1
for i in `seq 1 10`; do
    HTTP_STATUS_CODE=`curl -s -o /dev/null -w "%{http_code}" $GITHUB_STATUS_API`
    if [[ $HTTP_STATUS_CODE == "200" ]]; then
      rc=0
      break
    fi
    /usr/bin/logger "ERROR: FIREROUTER.UPGRADE NO Network $i"
    sleep 1
done

if [[ $rc -ne 0 ]]
then
    /home/pi/firerouter/scripts/firelog -t local -m "FIREROUTER.UPGRADE($mode) Starting RECOVER NETWORK "+`date`
    external_script='sudo  CHECK_FIX_NETWORK_REBOOT=no CHECK_FIX_NETWORK_RETRY=no /home/pi/firerouter/scripts/check_fix_network.sh'
    if [ -s /home/pi/scripts/check_fix_network.sh ]
    then
        external_script='sudo  CHECK_FIX_NETWORK_REBOOT=no CHECK_FIX_NETWORK_RETRY=no /home/pi/scripts/check_fix_network.sh'
    else
        external_script='sudo  CHECK_FIX_NETWORK_REBOOT=no CHECK_FIX_NETWORK_RETRY=no /home/pi/firerouter/scripts/check_fix_network.sh'
    fi
    $external_script &>/dev/null &
    timeout_check || /home/pi/firerouter/scripts/firelog -t local -m "FIREROUTER.UPGRADE($mode) Starting RECOVER TIMEOUT"+`date`
    /home/pi/firerouter/scripts/firelog -t local -m "FIREROUTER.UPGRADE($mode) Ending RECOVER NETWORK "+`date`
fi


/usr/bin/logger "FIREROUTER.UPGRADE.SYNCDONE  "+`date`


cd /home/pi/firerouter
sudo chown -R pi /home/pi/firerouter/.git
branch=$(git rev-parse --abbrev-ref HEAD)

# continue to try upgrade even github api is not successfully.
# very likely to fail

echo "upgrade on branch $branch"

commit_before=$(git rev-parse HEAD)
current_tag=$(git describe --tags)

echo $commit_before > /tmp/REPO_HEAD
echo $current_tag > /tmp/REPO_TAG
echo $branch > /tmp/REPO_BRANCH

if [[ -e "/home/pi/.router/config/.no_auto_upgrade" ]]; then
  /home/pi/firerouter/scripts/firelog -t debug -m "FIREROUTER.UPGRADE NO UPGRADE"
  echo '======= SKIP UPGRADING BECAUSE OF FLAG /home/pi/.router/config/.no_auto_upgrade ======='
  exit 0
fi

if $(/bin/systemctl -q is-active watchdog.service) ; then sudo /bin/systemctl stop watchdog.service ; fi
sudo rm -f /home/pi/firerouter/.git/*.lock
GIT_COMMAND="(sudo -u pi $MGIT fetch origin $branch && sudo -u pi $MGIT reset --hard FETCH_HEAD)"
eval $GIT_COMMAND ||
  (sleep 3; eval $GIT_COMMAND) ||
  (sleep 3; eval $GIT_COMMAND) ||
  (sleep 3; eval $GIT_COMMAND) || (date >> ~/.fireupgrade.failed; exit 1)

commit_after=$(git rev-parse HEAD)
current_tag=$(git describe --tags)

echo $commit_after > /tmp/REPO_HEAD
echo $current_tag > /tmp/REPO_TAG


/home/pi/firerouter/scripts/firelog -t debug -m  "FIREROUTER.UPGRADE Done $branch"

# in case there is some upgrade change on firewalla.service
# all the rest services will be updated (in case) via firewalla.service

sudo cp /home/pi/firerouter/scripts/firerouter.service /etc/systemd/system/.
sudo cp /home/pi/firerouter/scripts/fireboot.service /etc/systemd/system/.
sudo systemctl daemon-reload
sudo systemctl reenable firerouter
sudo systemctl reenable firerouter_upgrade
sudo systemctl reenable fireboot

case $mode in
    normal)
        /home/pi/firerouter/scripts/firerouter_upgrade_normal.sh
        ;;
    hard)
        /home/pi/firerouter/scripts/firerouter_upgrade_hard.sh
        ;;
    soft)
        /home/pi/firerouter/scripts/firerouter_upgrade_soft.sh
        ;;
esac
