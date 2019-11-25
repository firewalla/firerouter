#!/bin/bash
%FIREROUTER_HOME%/bin/dnsmasq -k --clear-on-reload -u pi -C %FIREROUTER_HOME%/etc/dnsmasq.dns.default.conf &
trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT
for job in `jobs -p`; do wait $job; echo "$job exited"; done