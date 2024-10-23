#! /usr/bin/env bash

FRCANARY_FLAG="/home/pi/.router/config/.no_upgrade_canary"
FRCANARY_FORCE="/home/pi/.router/config/.force_upgrade_canary"

rm -f $FRCANARY_FLAG

logger "FIREROUTER:UPGRADE_CANARY:START"

if [[ -e $FRCANARY_FORCE ]]; then
  echo "======= FIREROUTER CANARY ALL UPGRADE BECAUSE OF FLAG $FRCANARY_FORCE ======="
  rm -f $FRCANARY_FORCE
  exit 0
fi

err() {
  echo "ERROR: $@" >&2
}

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREROUTER_HOME:=/home/pi/firerouter}
source ${FIREWALLA_HOME}/platform/platform.sh

[ -s ~/.fwrc ] && source ~/.fwrc
[ -s ${FIREWALLA_HOME}/scripts/network_settings.sh ] && source ${FIREWALLA_HOME}/scripts/network_settings.sh

## CANARY DEPLOYMENT RATIO CONFIG PATH
pushd ${FIREROUTER_HOME}
sudo chown -R pi ${FIREROUTER_HOME}/.git
FR_BRANCH=$(git rev-parse --abbrev-ref HEAD)
popd

: ${FW_ENDPOINT:=$(get_cloud_endpoint)}
FW_VERSION=$(cat $FIREWALLA_HOME/net2/config.json | jq .version)
FW_URL="${FW_ENDPOINT}?type=box_update&model=${FIREWALLA_PLATFORM}&branch=${FR_BRANCH}&version=${FW_VERSION}"
FWRCMD="curl -s --max-time 5 -H 'Authorization: Bearer $(redis-cli hget sys:ept token)' '$FW_URL' | jq '. | length' "
ratio=$(eval $FWRCMD)
if [ "$ratio" == "0" ];
then
    echo "======= FIREROUTER CANARY NO UPGRADING FOR CLOUD DECISION (ratio=$ratio)======="
    echo $(date +%s) > ${FRCANARY_FLAG}
else
    echo "======= FIREROUTER CANARY UPGRADING (ratio=$ratio)======="
fi

logger "FIREROUTER:UPGRADE_CANARY:END"