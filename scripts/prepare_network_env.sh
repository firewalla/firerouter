#!/bin/bash

TMPDIR_PATH="/dev/shm"

# ------ initialize iptables/ipset restore files
rm -f ${TMPDIR_PATH}/fr_prepare_network_env.iptables.restore.* \
  ${TMPDIR_PATH}/fr_prepare_network_env.ip6tables.restore.* \
  ${TMPDIR_PATH}/fr_prepare_network_env.ipset.restore.*

RESTORE_TS="$(date +%s)"
IPTABLES_RESTORE_FILE="${TMPDIR_PATH}/fr_prepare_network_env.iptables.restore.${RESTORE_TS}"
IP6TABLES_RESTORE_FILE="${TMPDIR_PATH}/fr_prepare_network_env.ip6tables.restore.${RESTORE_TS}"
IPSET_RESTORE_FILE="${TMPDIR_PATH}/fr_prepare_network_env.ipset.restore.${RESTORE_TS}"

: > "$IPTABLES_RESTORE_FILE"
: > "$IP6TABLES_RESTORE_FILE"
: > "$IPSET_RESTORE_FILE"

append_iptables() { printf '%s\n' "$@" >> "$IPTABLES_RESTORE_FILE"; }
append_ip6tables() { printf '%s\n' "$@" >> "$IP6TABLES_RESTORE_FILE"; }
append_ipset() { printf '%s\n' "$@" >> "$IPSET_RESTORE_FILE"; }

# save FR_SNAT to FR_SNAT_TMP temporarily to avoid no snat during firerouter setup
sudo iptables -w -t nat -F FR_SNAT_TMP &> /dev/null
sudo iptables -w -t nat -C POSTROUTING -j FR_SNAT_TMP &>/dev/null && sudo iptables -w -t nat -D POSTROUTING -j FR_SNAT_TMP &>/dev/null
sudo iptables -w -t nat -X FR_SNAT_TMP &> /dev/null
sudo iptables -w -t nat -E FR_SNAT FR_SNAT_TMP &>/dev/null
if sudo iptables -w -t nat -L FR_SNAT_TMP &>/dev/null; then
  sudo iptables -w -t nat -A POSTROUTING -j FR_SNAT_TMP &>/dev/null
fi

append_iptables "*nat"
append_iptables ":FR_PREROUTING - [0:0]"
append_iptables ":FR_UPNP - [0:0]"
append_iptables ":FR_UPNP_POSTROUTING - [0:0]"
append_iptables ":FR_WIREGUARD - [0:0]"
append_iptables ":FR_AMNEZIA_WG - [0:0]"
append_iptables ":FR_POSTROUTING - [0:0]"
append_iptables ":FR_PASSTHROUGH - [0:0]"
append_iptables ":FR_SNAT - [0:0]"
append_iptables ":FR_OUTPUT_SNAT - [0:0]"
append_iptables "-A FR_PREROUTING -j FR_UPNP"
append_iptables "-A FR_POSTROUTING -j FR_PASSTHROUGH"
append_iptables "-A FR_POSTROUTING -j FR_SNAT"
append_iptables "-A FR_POSTROUTING -j FR_OUTPUT_SNAT"
append_iptables "COMMIT"

append_iptables "*mangle"
append_iptables ":FR_PREROUTING - [0:0]"
append_iptables ":FR_MROUTE - [0:0]"
append_iptables ":FR_OUTPUT - [0:0]"
append_iptables "-A FR_PREROUTING -m connmark ! --mark 0x0000/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff"
append_iptables "-A FR_PREROUTING -m mark ! --mark 0x0/0xffff -j CONNMARK --save-mark --nfmask 0xffff --ctmask 0xffff"
append_iptables "-A FR_PREROUTING -m addrtype --dst-type MULTICAST -m addrtype ! --src-type LOCAL -j FR_MROUTE"
append_iptables "-A FR_OUTPUT -m connmark ! --mark 0x0000/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff"
append_iptables "COMMIT"

append_iptables "*filter"
append_iptables ":FR_UPNP_ACCEPT - [0:0]"
append_iptables ":FR_INPUT - [0:0]"
append_iptables ":FR_IGMP - [0:0]"
append_iptables ":FR_ICMP - [0:0]"
append_iptables ":FR_SSH - [0:0]"
append_iptables ":FR_WIREGUARD - [0:0]"
append_iptables ":FR_AMNEZIA_WG - [0:0]"
append_iptables ":FR_FORWARD - [0:0]"
append_iptables ":FR_PASSTHROUGH - [0:0]"
append_iptables ":FR_OSI_INSPECTION - [0:0]"
append_iptables ":FR_OSI_RULES - [0:0]"
append_iptables ":FR_OSI - [0:0]"
append_iptables "-A FR_INPUT -m addrtype --src-type LOCAL -j ACCEPT"
append_iptables "-A FR_INPUT -p udp --sport 67 --dport 68 -j ACCEPT"
append_iptables "-A FR_INPUT -j FR_IGMP"
append_iptables "-A FR_INPUT -j FR_ICMP"
append_iptables "-A FR_INPUT -j FR_SSH"
append_iptables "-A FR_INPUT -j FR_WIREGUARD"
append_iptables "-A FR_INPUT -j FR_AMNEZIA_WG"
append_iptables "-A FR_FORWARD -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"
append_iptables "-A FR_FORWARD -j FR_PASSTHROUGH"
append_iptables "-A FR_FORWARD -j FR_IGMP"
append_iptables "-A FR_OSI_INSPECTION -m set --match-set osi_match_all_knob src -j DROP"
append_iptables "-A FR_OSI_INSPECTION -m set --match-set osi_match_all_knob dst -j DROP"
append_iptables "-A FR_OSI_INSPECTION -m set --match-set osi_verified_mac_set src -j RETURN"
append_iptables "-A FR_OSI_INSPECTION -m set --match-set osi_verified_subnet_set src -j RETURN"
append_iptables "-A FR_OSI_INSPECTION -m set --match-set osi_verified_subnet_set dst -j RETURN"
append_iptables "-A FR_OSI_INSPECTION -j DROP"
append_iptables "-A FR_OSI_RULES -m set --match-set osi_rules_match_all_knob src -j DROP"
append_iptables "-A FR_OSI_RULES -m set --match-set osi_rules_match_all_knob dst -j DROP"
append_iptables "-A FR_OSI -m set --match-set osi_wan_inbound_set src,src -j DROP"
append_iptables "-A FR_OSI -m set --match-set osi_mac_set src -j FR_OSI_INSPECTION"
append_iptables "-A FR_OSI -m set --match-set osi_subnet_set src -j FR_OSI_INSPECTION"
append_iptables "-A FR_OSI -m set --match-set osi_subnet_set dst -j FR_OSI_INSPECTION"
append_iptables "-A FR_OSI -m set --match-set osi_rules_mac_set src -j FR_OSI_RULES"
append_iptables "-A FR_OSI -m set --match-set osi_rules_subnet_set src -j FR_OSI_RULES"
append_iptables "-A FR_OSI -m set --match-set osi_rules_subnet_set dst -j FR_OSI_RULES"
append_iptables "-A FR_FORWARD -m conntrack --ctstate NEW -j FR_OSI"
append_iptables "-A FR_INPUT -m conntrack --ctstate NEW -j FR_OSI"
append_iptables "COMMIT"

append_ip6tables "*nat"
append_ip6tables ":FR_PREROUTING - [0:0]"
append_ip6tables ":FR_WIREGUARD - [0:0]"
append_ip6tables ":FR_AMNEZIA_WG - [0:0]"
append_ip6tables ":FR_POSTROUTING - [0:0]"
append_ip6tables ":FR_PASSTHROUGH - [0:0]"
append_ip6tables ":FR_SNAT - [0:0]"
append_ip6tables ":FR_OUTPUT_SNAT - [0:0]"
append_ip6tables "-A FR_POSTROUTING -j FR_PASSTHROUGH"
append_ip6tables "-A FR_POSTROUTING -j FR_SNAT"
append_ip6tables "-A FR_POSTROUTING -j FR_OUTPUT_SNAT"
append_ip6tables "COMMIT"

append_ip6tables "*mangle"
append_ip6tables ":FR_PREROUTING - [0:0]"
append_ip6tables ":FR_MROUTE - [0:0]"
append_ip6tables ":FR_OUTPUT - [0:0]"
append_ip6tables "-A FR_PREROUTING -m connmark ! --mark 0x0000/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff"
append_ip6tables "-A FR_PREROUTING -m mark ! --mark 0x0/0xffff -j CONNMARK --save-mark --nfmask 0xffff --ctmask 0xffff"
append_ip6tables "-A FR_PREROUTING -m addrtype --dst-type MULTICAST -m addrtype ! --src-type LOCAL -j FR_MROUTE"
append_ip6tables "-A FR_OUTPUT -m connmark ! --mark 0x0000/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff"
append_ip6tables "COMMIT"

append_ip6tables "*filter"
append_ip6tables ":FR_INPUT - [0:0]"
append_ip6tables ":FR_ICMP - [0:0]"
append_ip6tables ":FR_WIREGUARD - [0:0]"
append_ip6tables ":FR_AMNEZIA_WG - [0:0]"
append_ip6tables ":FR_FORWARD - [0:0]"
append_ip6tables ":FR_PASSTHROUGH - [0:0]"
append_ip6tables ":FR_OSI_INSPECTION - [0:0]"
append_ip6tables ":FR_OSI_RULES - [0:0]"
append_ip6tables ":FR_OSI - [0:0]"
append_ip6tables "-A FR_INPUT -m addrtype --src-type LOCAL -j ACCEPT"
append_ip6tables "-A FR_INPUT -p udp --sport 547 --dport 546 -j ACCEPT"
append_ip6tables "-A FR_INPUT -p icmpv6 --icmpv6-type neighbour-solicitation -j ACCEPT"
append_ip6tables "-A FR_INPUT -p icmpv6 --icmpv6-type neighbour-advertisement -j ACCEPT"
append_ip6tables "-A FR_INPUT -p icmpv6 --icmpv6-type router-advertisement -j ACCEPT"
append_ip6tables "-A FR_INPUT -j FR_ICMP"
append_ip6tables "-A FR_INPUT -j FR_WIREGUARD"
append_ip6tables "-A FR_INPUT -j FR_AMNEZIA_WG"
append_ip6tables "-A FR_FORWARD -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"
append_ip6tables "-A FR_FORWARD -j FR_PASSTHROUGH"
append_ip6tables "-A FR_OSI_INSPECTION -m set --match-set osi_match_all_knob6 src -j DROP"
append_ip6tables "-A FR_OSI_INSPECTION -m set --match-set osi_match_all_knob6 dst -j DROP"
append_ip6tables "-A FR_OSI_INSPECTION -m set --match-set osi_verified_mac_set src -j RETURN"
append_ip6tables "-A FR_OSI_INSPECTION -m set --match-set osi_verified_subnet6_set src -j RETURN"
append_ip6tables "-A FR_OSI_INSPECTION -m set --match-set osi_verified_subnet6_set dst -j RETURN"
append_ip6tables "-A FR_OSI_INSPECTION -j DROP"
append_ip6tables "-A FR_OSI_RULES -m set --match-set osi_rules_match_all_knob6 src -j DROP"
append_ip6tables "-A FR_OSI_RULES -m set --match-set osi_rules_match_all_knob6 dst -j DROP"
append_ip6tables "-A FR_OSI -m set --match-set osi_wan_inbound_set6 src,src -j DROP"
append_ip6tables "-A FR_OSI -m set --match-set osi_mac_set src -j FR_OSI_INSPECTION"
append_ip6tables "-A FR_OSI -m set --match-set osi_subnet6_set src -j FR_OSI_INSPECTION"
append_ip6tables "-A FR_OSI -m set --match-set osi_subnet6_set dst -j FR_OSI_INSPECTION"
append_ip6tables "-A FR_OSI -m set --match-set osi_rules_mac_set src -j FR_OSI_RULES"
append_ip6tables "-A FR_OSI -m set --match-set osi_rules_subnet6_set src -j FR_OSI_RULES"
append_ip6tables "-A FR_OSI -m set --match-set osi_rules_subnet6_set dst -j FR_OSI_RULES"
append_ip6tables "-A FR_FORWARD -m conntrack --ctstate NEW -j FR_OSI"
append_ip6tables "-A FR_INPUT -m conntrack --ctstate NEW -j FR_OSI"
append_ip6tables "COMMIT"

append_ipset "create -! osi_mac_set hash:mac timeout 600"
append_ipset "create -! osi_subnet_set hash:net timeout 600"
append_ipset "create -! osi_rules_mac_set hash:mac timeout 600"
append_ipset "create -! osi_rules_subnet_set hash:net timeout 600"
append_ipset "flush -! osi_mac_set"
append_ipset "flush -! osi_subnet_set"
append_ipset "flush -! osi_rules_mac_set"
append_ipset "flush -! osi_rules_subnet_set"
append_ipset "create -! osi_wan_inbound_set hash:net,iface timeout 600"
append_ipset "flush -! osi_wan_inbound_set"
append_ipset "create -! osi_match_all_knob hash:net"
append_ipset "flush -! osi_match_all_knob"
append_ipset "add -! osi_match_all_knob 0.0.0.0/1"
append_ipset "add -! osi_match_all_knob 128.0.0.0/1"
append_ipset "create -! osi_rules_match_all_knob hash:net"
append_ipset "flush -! osi_rules_match_all_knob"
append_ipset "add -! osi_rules_match_all_knob 0.0.0.0/1"
append_ipset "add -! osi_rules_match_all_knob 128.0.0.0/1"
append_ipset "create -! osi_verified_mac_set hash:mac"
append_ipset "create -! osi_verified_subnet_set hash:net"
append_ipset "create -! osi_subnet6_set hash:net family inet6 timeout 600"
append_ipset "create -! osi_rules_subnet6_set hash:net family inet6 timeout 600"
append_ipset "flush -! osi_subnet6_set"
append_ipset "flush -! osi_rules_subnet6_set"
append_ipset "create -! osi_wan_inbound_set6 hash:net,iface family inet6 timeout 600"
append_ipset "flush -! osi_wan_inbound_set6"
append_ipset "create -! osi_match_all_knob6 hash:net family inet6"
append_ipset "flush -! osi_match_all_knob6"
append_ipset "add -! osi_match_all_knob6 ::/1"
append_ipset "add -! osi_match_all_knob6 8000::/1"
append_ipset "create -! osi_rules_match_all_knob6 hash:net family inet6"
append_ipset "flush -! osi_rules_match_all_knob6"
append_ipset "add -! osi_rules_match_all_knob6 ::/1"
append_ipset "add -! osi_rules_match_all_knob6 8000::/1"
append_ipset "create -! osi_verified_subnet6_set hash:net family inet6"

sudo ipset restore -! < "$IPSET_RESTORE_FILE"
sudo iptables-restore -w -n "$IPTABLES_RESTORE_FILE"
sudo ip6tables-restore -w -n "$IP6TABLES_RESTORE_FILE"

sudo iptables -w -t nat -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo iptables -w -t nat -I PREROUTING -j FR_PREROUTING
sudo iptables -w -t nat -C POSTROUTING -j FR_POSTROUTING &>/dev/null || sudo iptables -w -t nat -I POSTROUTING -j FR_POSTROUTING
sudo iptables -w -t mangle -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -j FR_PREROUTING
sudo iptables -w -t mangle -C OUTPUT -j FR_OUTPUT &>/dev/null || sudo iptables -w -t mangle -A OUTPUT -j FR_OUTPUT
sudo iptables -w -C INPUT -j FR_INPUT &> /dev/null || sudo iptables -w -I INPUT -j FR_INPUT
sudo iptables -w -C FORWARD -j FR_FORWARD &>/dev/null || sudo iptables -w -I FORWARD -j FR_FORWARD

sudo ip6tables -w -t nat -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo ip6tables -w -t nat -I PREROUTING -j FR_PREROUTING
sudo ip6tables -w -t nat -C POSTROUTING -j FR_POSTROUTING &>/dev/null || sudo ip6tables -w -t nat -I POSTROUTING -j FR_POSTROUTING
sudo ip6tables -w -t mangle -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -j FR_PREROUTING
sudo ip6tables -w -t mangle -C OUTPUT -j FR_OUTPUT &>/dev/null || sudo ip6tables -w -t mangle -A OUTPUT -j FR_OUTPUT
sudo ip6tables -w -C INPUT -j FR_INPUT &> /dev/null || sudo ip6tables -w -I INPUT -j FR_INPUT
sudo ip6tables -w -C FORWARD -j FR_FORWARD &>/dev/null || sudo ip6tables -w -I FORWARD -j FR_FORWARD

OSI_TIMEOUT=$(redis-cli get osi:admin:timeout)
if [[ -z "$OSI_TIMEOUT" ]]; then
  OSI_TIMEOUT=600 # default 10 mins
fi

mode=$(redis-cli get mode)
if [[ -z "$mode" ]]; then
  mode="router"
fi

function prepare_osi {
  # fullfil from redis
  redis-cli smembers osi:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "mac" || $1 == "tag" {print "add osi_mac_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null
  redis-cli smembers osi:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "network" || $1 == "identity" || $1 == "identityTag" {print "add osi_subnet_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null
  redis-cli smembers osi:rules:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "mac" || $1 == "tag" {print "add osi_rules_mac_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null
  redis-cli smembers osi:rules:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "network" || $1 == "identity" || $1 == "identityTag" {print "add osi_rules_subnet_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null

  # only clear for initial setup
  sudo ipset flush -! osi_verified_mac_set &>/dev/null
  sudo ipset flush -! osi_verified_subnet_set &>/dev/null

  if [[ $mode == "router" ]]; then
    wans=$(curl 'http://localhost:8837/v1/config/wans' | jq -r 'keys[]')
    while IFS= read -r wan; do
      sudo ipset add -! osi_wan_inbound_set 0.0.0.0/1,$wan
      sudo ipset add -! osi_wan_inbound_set 128.0.0.0/1,$wan
    done <<< "$wans"
  fi
}


# DO NOT FULLFIL FROM REDIS WHEN FIREWALLA IS ALREADY RUNNING
# main.touch means firemain service has ever started at once
# if this file doesnt exist, it means a FRESH BOOT UP
if [[ ! -e /dev/shm/main.touch ]]; then
  # Only if FW_FORWARD does NOT exist
  if ! sudo iptables -S FW_FORWARD &>/dev/null; then
    # put it to background to speed up
    prepare_osi &
  fi
fi


function prepare_osi6 {
  # fullfil from redis
  # only need to fulfill the ipv6 specific ones
  redis-cli smembers osi:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "network6" {print "add osi_subnet6_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null
  redis-cli smembers osi:rules:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "network6" {print "add osi_rules_subnet6_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null

  sudo ipset flush -! osi_verified_subnet6_set &>/dev/null

  if [[ $mode == "router" ]]; then
    wans=$(curl 'http://localhost:8837/v1/config/wans' | jq -r 'keys[]')
    while IFS= read -r wan; do
      sudo ipset add -! osi_wan_inbound_set6 ::/1,$wan
      sudo ipset add -! osi_wan_inbound_set6 8000::/1,$wan
    done <<< "$wans"
  fi
}

# DO NOT FULLFIL FROM REDIS WHEN FIREWALLA IS ALREADY RUNNING
# main.touch means firemain service has ever started at once
# if this file doesnt exist, it means a FRESH BOOT UP
if [[ ! -e /dev/shm/main.touch ]]; then
  # Only if FW_FORWARD does NOT exist
  if ! sudo ip6tables -S FW_FORWARD &>/dev/null; then
    prepare_osi6 &
  fi
fi

# ------ flush routing tables
sudo flock /tmp/rt_tables.lock -c "
sudo ip r flush table global_local
sudo ip r flush table global_default
sudo ip r flush table wan_routable metric 0 # only delete routes with metric 0, routes with non-zero metric are not added by firerouter
sudo ip r flush table lan_routable metric 0
sudo ip r flush table static

sudo ip -6 r flush table global_local
sudo ip -6 r flush table global_default
sudo ip -6 r flush table wan_routable metric 0
sudo ip -6 r flush table lan_routable metric 0
sudo ip -6 r flush table static
"

# ------ initialize ip rules
# do not touch ip rules created by Firewalla
# intermediate state of ip rule initializaton may result in wrong routing decision and wrongly accepts a packet that should be blocked, so temporarily suspend packet forward
sudo iptables -w -C FR_FORWARD -m comment --comment "forward temp suspend" -j DROP &> /dev/null || sudo iptables -w -I FR_FORWARD -m comment --comment "forward temp suspend" -j DROP
rules_to_remove=`ip rule list | grep -v -e "^\(5000\|6000\|10000\):" | cut -d: -f2-`;
while IFS= read -r line; do
  sudo ip rule del $line
done <<< "$rules_to_remove"
sudo flock /tmp/rt_tables.lock -c "
sudo ip rule add pref 0 from all lookup local
sudo ip rule add pref 32766 from all lookup main
sudo ip rule add pref 32767 from all lookup default

sudo ip rule add pref 500 from all iif lo lookup global_local
sudo ip rule add pref 4001 from all lookup static
"
sudo iptables -w -D FR_FORWARD -m comment --comment "forward temp suspend" -j DROP

sudo ip6tables -w -C FR_FORWARD -m comment --comment "forward temp suspend" -j DROP &> /dev/null || sudo ip6tables -w -I FR_FORWARD -m comment --comment "forward temp suspend" -j DROP
rules_to_remove=`ip -6 rule list | grep -v -e "^\(5000\|6000\|10000\):" | cut -d: -f2-`;
while IFS= read -r line; do
  sudo ip -6 rule del $line
done <<< "$rules_to_remove"
sudo flock /tmp/rt_tables.lock -c "
sudo ip -6 rule add pref 0 from all lookup local
sudo ip -6 rule add pref 32766 from all lookup main
sudo ip -6 rule add pref 32767 from all lookup default

sudo ip -6 rule add pref 500 from all iif lo lookup global_local
sudo ip -6 rule add pref 4001 from all lookup static
"
sudo ip6tables -w -D FR_FORWARD -m comment --comment "forward temp suspend" -j DROP
