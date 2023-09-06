#!/bin/bash

# This script should only handle FireRouter upgrade, nothing else
#
# WARNING:  EXTRA CARE NEEDED FOR THIS SCRIPT!  ANYTHING BROKEN HERE
# WILL PREVENT UPGRADES!

: ${FIREROUTER_HOME:=/home/pi/firerouter}
: ${FIREWALLA_HOME:=/home/pi/firewalla}
MGIT=$(PATH=/home/pi/scripts:$FIREROUTER_HOME/scripts; /usr/bin/which mgit||echo git)

source ${FIREROUTER_HOME}/platform/platform.sh

# timeout_check - timeout control given process or last background process
# returns:
#   0 - process exits before timeout
#   1 - process killed due to timeout
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

function sync_time() {
    time_website=$1
    logger "Syncing time from ${time_website}..."
    time=$(curl -ILsm5 ${time_website} | awk -F ": " '/^[Dd]ate: / {print $2}'|tail -1)
    if [[ "x$time" == "x" ]]; then
        logger "ERROR: Failed to load date info from website: $time_website"
        return 1
    else
        # compare website time against threshold to prevent it goes bad in some rare cases
        tsWebsite=$(date -d "$time" +%s)
        tsThreshold=$(date -d "$TIME_THRESHOLD" +%s)
        if [ $tsWebsite -ge $tsThreshold ];
        then
          echo "$tsWebsite";
          return 0
        else
          return 1
        fi
    fi
}

logger "FIREROUTER.UPGRADE.DATE.SYNC"
FW_SYNC_TIME_SCRIPT=$FIREWALLA_HOME/scripts/sync_time.sh
if [[ -e $FW_SYNC_TIME_SCRIPT ]]
then
    SYNC_ONCE=true $FW_SYNC_TIME_SCRIPT
else
    TIME_THRESHOLD="2020-05-21"
    tsWebsite=$(sync_time status.github.com || sync_time google.com || sync_time live.com || sync_time facebook.com)
    tsSystem=$(date +%s)
    if [ "0$tsWebsite" -ge "0$tsSystem" ]; # prefix 0 as tsWebsite could be empty
    then
        sudo date +%s -s "@$tsWebsite";
    fi
fi
logger "FIREROUTER.UPGRADE.DATE.SYNC.DONE"
sync

NETWORK_CHECK_HOSTS='
  1.1.1.1 443
  1.0.0.1 443
  8.8.8.8 443
  9.9.9.9 443
  208.67.222.222 443
  149.112.112.112 443
  check.firewalla.com 443
'

logger `date`
rc=1
for i in `seq 1 10`; do
  while read NETWORK_CHECK_HOST NETWORK_CHECK_PORT; do
    test -n "$NETWORK_CHECK_HOST" || continue
    test -n "$NETWORK_CHECK_PORT" || continue

    # no need to check status code, even 4xx/5xx means the network is accessible
    if nc -v -z -w 3 $NETWORK_CHECK_HOST $NETWORK_CHECK_PORT; then
      rc=0
      break
    fi

    /usr/bin/logger "ERROR: cannot access $NETWORK_CHECK_HOST"
  done < <(echo "$NETWORK_CHECK_HOSTS")
  if [[ $rc -eq 0 ]]; then
    break
  fi
  /usr/bin/logger "ERROR: FIREROUTER.UPGRADE NO Network $i"
  sleep 1
done

if [[ $rc -ne 0 ]]
then
    /home/pi/firerouter/scripts/firelog -t local -m "FIREROUTER.UPGRADE($mode) Failed No Network "+`date`
    rm -f /dev/shm/firerouter.upgraded
    touch /dev/shm/firerouter.upgrade.failed
    exit 1
fi


cd /home/pi/firerouter
sudo chown -R pi /home/pi/firerouter/.git
branch=$(git rev-parse --abbrev-ref HEAD)
remote_branch=$(map_target_branch $branch)
# ensure the remote fetch branch is up-to-date
git config remote.origin.fetch "+refs/heads/$remote_branch:refs/remotes/origin/$remote_branch"
git config "branch.$branch.merge" "refs/heads/$remote_branch"
$MGIT fetch

current_hash=$(git rev-parse HEAD)
latest_hash=$(git rev-parse origin/$remote_branch)

if [ "$current_hash" == "$latest_hash" ]; then
   /home/pi/firerouter/scripts/firelog -t local -m "FIREROUTER.UPGRADECHECK.DONE.NOTHING"
   rm -f /dev/shm/firerouter.upgraded
   exit 0
fi 

# continue to try upgrade even github api is not successfully.
# very likely to fail

echo "upgrade on branch $branch"

if [[ -e "/home/pi/.router/config/.no_auto_upgrade" ]]; then
  /home/pi/firerouter/scripts/firelog -t debug -m "FIREROUTER.UPGRADE NO UPGRADE"
  echo '======= SKIP UPGRADING BECAUSE OF FLAG /home/pi/.router/config/.no_auto_upgrade ======='
  rm -f /dev/shm/firerouter.upgraded
  exit 0
fi

if $(/bin/systemctl -q is-active watchdog.service) ; then sudo /bin/systemctl stop watchdog.service ; fi
sudo rm -f /home/pi/firerouter/.git/*.lock
GIT_COMMAND="(sudo -u pi $MGIT fetch origin $remote_branch && sudo -u pi $MGIT reset --hard FETCH_HEAD)"
eval $GIT_COMMAND ||
  (sleep 3; eval $GIT_COMMAND) ||
  (sleep 3; eval $GIT_COMMAND) ||
  (sleep 3; eval $GIT_COMMAND) || (date >> ~/.firerouter.upgrade.failed; exit 1)

# set node_modules link to the proper directory
NODE_MODULES_PATH=$(get_node_modules_dir)
if [[ -h ${FIREROUTER_HOME}/node_modules ]]; then
  if [[ $(readlink ${FIREROUTER_HOME}/node_modules) != $NODE_MODULES_PATH ]]; then
    ln -sfT $NODE_MODULES_PATH ${FIREROUTER_HOME}/node_modules
  fi
fi

touch /dev/shm/firerouter.upgraded

run-parts ${FIREROUTER_HOME}/scripts/post_upgrade.d/

/home/pi/firerouter/scripts/firelog -t debug -m  "FIREROUTER.UPGRADE Done $branch"

# in case there is some upgrade change on firewalla.service
# all the rest services will be updated (in case) via firewalla.service

if [[ $NETWORK_SETUP == "yes" ]]; then
  sudo cp /home/pi/firerouter/scripts/firerouter.service /etc/systemd/system/.
  sudo cp /home/pi/firerouter/scripts/fireboot.service /etc/systemd/system/.
else
  sudo cp /home/pi/firerouter/scripts/fireboot_standalone.service /etc/systemd/system/fireboot.service
fi

sudo cp /home/pi/firerouter/scripts/firereset.service /etc/systemd/system/.
sudo systemctl daemon-reload

if [[ $NETWORK_SETUP == "yes" ]]; then
  sudo systemctl reenable firerouter
fi

sudo systemctl reenable fireboot
sudo systemctl reenable firereset
