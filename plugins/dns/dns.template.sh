#!/bin/bash

for CONF_FILE in %FIREROUTER_HOME%/etc/dnsmasq.dns.*.conf; do
  [[ -f "$CONF_FILE" ]] && %DNSMASQ_BINARY% -k --clear-on-reload -u pi -C $CONF_FILE &
done;

trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT
for job in `jobs -p`; do wait $job; echo "$job exited"; done