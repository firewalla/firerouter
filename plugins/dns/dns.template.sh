#!/bin/bash

cd %FIREROUTER_HOME%
branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" == "master" ]]; then
  ulimit -c unlimited
else
  ulimit -c 0
fi

PIDS=""

source %FIREROUTER_HOME%/platform/platform.sh

DNSMASQ_BINARY=$(get_dnsmasq_path)

for CONF_FILE in %FIREROUTER_HOME%/etc/dnsmasq.dns.*.conf; do
  if [[ -e $CONF_FILE ]]; then
    $DNSMASQ_BINARY -k --clear-on-reload -u pi -C $CONF_FILE &
    PIDS="$PIDS $!"
  fi
done;

if [[ -n $PIDS ]]; then
  wait -n
  # considered as failure if any child process exits
  exit 1
else
  exit 0
fi