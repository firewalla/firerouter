#!/bin/bash

cd %FIREROUTER_HOME%
branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" == "master" ]]; then
  ulimit -c unlimited
else
  ulimit -c 0
fi

source %FIREROUTER_HOME%/platform/platform.sh

DNSMASQ_BINARY=$(get_dnsmasq_path)

# an instance that ran shorter than MIN_UP_SECS failed to start (bad conf, missing interface)
# 3 s: above the 1 s resolution of $SECONDS, far below any real run; failed starts die in ms
MIN_UP_SECS=${MIN_UP_SECS:-3}
MAX_DELAY=${MAX_DELAY:-30}
LOG_EVERY=${LOG_EVERY:-600}

# one instance's failure must not take down the others, so each is restarted on its own
run_instance() {
  local conf=$1 delay=0 prev start up rc
  local last_log=$((SECONDS - LOG_EVERY))
  while true; do
    start=$SECONDS
    $DNSMASQ_BINARY -k --clear-on-reload -u pi -C "$conf" &
    wait $!
    rc=$?
    up=$((SECONDS - start))
    prev=$delay
    if (( up >= MIN_UP_SECS )); then
      delay=0
    else
      delay=$(( delay ? delay * 2 : 1 ))
      (( delay > MAX_DELAY )) && delay=$MAX_DELAY
    fi
    # log every exit until the delay reaches the cap (that exit included), then one per LOG_EVERY
    if (( up >= MIN_UP_SECS || prev < MAX_DELAY || SECONDS - last_log >= LOG_EVERY )); then
      echo "dns_launcher: ${conf##*/} exited rc=$rc up=${up}s retry in ${delay}s"
      last_log=$SECONDS
    fi
    (( delay )) && sleep $delay
  done
}

STARTED=""

for CONF_FILE in %FIREROUTER_HOME%/etc/dnsmasq.dns.*.conf; do
  if [[ -e $CONF_FILE ]]; then
    run_instance "$CONF_FILE" &
    STARTED=1
  fi
done;

redis-cli HINCRBY "stats:systemd:restart" firerouter_dns 1

if [[ -n $STARTED ]]; then
  # the instances loop forever, this only keeps the unit alive
  wait
  exit 1
else
  exit 0
fi