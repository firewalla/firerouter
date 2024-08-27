#!/bin/bash

# ------ initialize iptables chains
sudo iptables -w -t nat -N FR_PREROUTING &> /dev/null
sudo iptables -w -t nat -F FR_PREROUTING
sudo iptables -w -t nat -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo iptables -w -t nat -I PREROUTING -j FR_PREROUTING

sudo iptables -w -t nat -N FR_UPNP &> /dev/null
sudo iptables -w -t nat -F FR_UPNP
sudo iptables -w -t nat -A FR_PREROUTING -j FR_UPNP

# not used, but it is required for miniupnpd to populate rules in forward chains
sudo iptables -w -t nat -N FR_UPNP_POSTROUTING &> /dev/null
sudo iptables -w -t nat -F FR_UPNP_POSTROUTING

sudo iptables -w -N FR_UPNP_ACCEPT &>/dev/null

sudo iptables -w -t nat -N FR_WIREGUARD &> /dev/null
sudo iptables -w -t nat -F FR_WIREGUARD

sudo iptables -w -t nat -N FR_POSTROUTING &> /dev/null
sudo iptables -w -t nat -F FR_POSTROUTING
sudo iptables -w -t nat -C POSTROUTING -j FR_POSTROUTING &>/dev/null || sudo iptables -w -t nat -I POSTROUTING -j FR_POSTROUTING

sudo iptables -w -t nat -N FR_PASSTHROUGH &> /dev/null
sudo iptables -w -t nat -F FR_PASSTHROUGH &> /dev/null
sudo iptables -w -t nat -A FR_POSTROUTING -j FR_PASSTHROUGH

sudo iptables -w -t nat -N FR_SNAT &> /dev/null
sudo iptables -w -t nat -F FR_SNAT &> /dev/null
sudo iptables -w -t nat -A FR_POSTROUTING -j FR_SNAT
sudo iptables -w -t nat -N FR_OUTPUT_SNAT &> /dev/null
sudo iptables -w -t nat -F FR_OUTPUT_SNAT &> /dev/null
sudo iptables -w -t nat -A FR_POSTROUTING -j FR_OUTPUT_SNAT

sudo iptables -w -t mangle -N FR_PREROUTING &>/dev/null
sudo iptables -w -t mangle -F FR_PREROUTING &>/dev/null
sudo iptables -w -t mangle -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -j FR_PREROUTING
# restore fwmark for packets belonging to inbound connection, this connmark is set in nat stage for inbound connection from wan
sudo iptables -w -t mangle -A FR_PREROUTING -m connmark ! --mark 0x0000/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
# save the updated fwmark into the connmark, which may be used in tc filter actions
sudo iptables -w -t mangle -A FR_PREROUTING -m mark ! --mark 0x0/0xffff -j CONNMARK --save-mark --nfmask 0xffff --ctmask 0xffff

sudo iptables -w -t mangle -N FR_MROUTE &>/dev/null
sudo iptables -w -t mangle -F FR_MROUTE &>/dev/null
sudo iptables -w -t mangle -C FR_PREROUTING -m addrtype --dst-type MULTICAST -m addrtype ! --src-type LOCAL -j FR_MROUTE &>/dev/null || sudo iptables -w -t mangle -A FR_PREROUTING -m addrtype --dst-type MULTICAST -m addrtype ! --src-type LOCAL -j FR_MROUTE

sudo iptables -w -t mangle -N FR_OUTPUT &> /dev/null
sudo iptables -w -t mangle -F FR_OUTPUT &> /dev/null
sudo iptables -w -t mangle -C OUTPUT -j FR_OUTPUT &>/dev/null || sudo iptables -w -t mangle -A OUTPUT -j FR_OUTPUT
# restore fwmark for output packets belonging to inbound connection, this connmark is set in nat stage for inbound connection from wan
sudo iptables -w -t mangle -A FR_OUTPUT -m connmark ! --mark 0x0000/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff

sudo iptables -w -N FR_INPUT &> /dev/null
sudo iptables -w -F FR_INPUT

# always accept loopback traffic
sudo iptables -w -A FR_INPUT -m addrtype --src-type LOCAL -j ACCEPT
# always accept dhcp reply from server to local
sudo iptables -w -A FR_INPUT -p udp --sport 67 --dport 68 -j ACCEPT
sudo iptables -w -C INPUT -j FR_INPUT &> /dev/null || sudo iptables -w -I INPUT -j FR_INPUT

# chain for igmp proxy
sudo iptables -w -N FR_IGMP &> /dev/null
sudo iptables -w -F FR_IGMP

sudo iptables -w -A FR_INPUT -j FR_IGMP

# chain for icmp
sudo iptables -w -N FR_ICMP &> /dev/null
sudo iptables -w -F FR_ICMP

sudo iptables -w -A FR_INPUT -j FR_ICMP

# chain for ssh
sudo iptables -w -N FR_SSH &> /dev/null
sudo iptables -w -F FR_SSH

sudo iptables -w -A FR_INPUT -j FR_SSH

# chain for wireguard
sudo iptables -w -N FR_WIREGUARD &> /dev/null
sudo iptables -w -F FR_WIREGUARD

sudo iptables -w -A FR_INPUT -j FR_WIREGUARD

sudo iptables -w -N FR_FORWARD &> /dev/null
sudo iptables -w -F FR_FORWARD
sudo iptables -w -C FORWARD -j FR_FORWARD &>/dev/null || sudo iptables -w -I FORWARD -j FR_FORWARD
# adjust TCP MSS for specific ethernet encapsulation, e.g., PPPoE
sudo iptables -w -A FR_FORWARD -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
# chain for NAT passthrough
sudo iptables -w -N FR_PASSTHROUGH &> /dev/null
sudo iptables -w -F FR_PASSTHROUGH
sudo iptables -w -A FR_FORWARD -j FR_PASSTHROUGH

sudo iptables -w -A FR_FORWARD -j FR_IGMP

# chain for Office Secondary Inspection
# any mac address or subnet in this set will be blocked until fully verified
# use timeout for final protection, in case something is wrong
sudo ipset create -! osi_mac_set hash:mac timeout 600 &>/dev/null
sudo ipset create -! osi_subnet_set hash:net timeout 600 &>/dev/null
sudo ipset create -! osi_rules_mac_set hash:mac timeout 600 &>/dev/null
sudo ipset create -! osi_rules_subnet_set hash:net timeout 600 &>/dev/null
sudo ipset flush -! osi_mac_set &>/dev/null
sudo ipset flush -! osi_subnet_set &>/dev/null
sudo ipset flush -! osi_rules_mac_set &>/dev/null
sudo ipset flush -! osi_rules_subnet_set &>/dev/null

# ipset for wan inbound block during reboot, service restart/upgrade
sudo ipset create -! osi_wan_inbound_set hash:net,iface timeout 600 &>/dev/null
sudo ipset flush -! osi_wan_inbound_set &> /dev/null

# use this knob to match everything if needed
sudo ipset create -! osi_match_all_knob hash:net &>/dev/null
sudo ipset flush -! osi_match_all_knob &>/dev/null
sudo ipset add -! osi_match_all_knob 0.0.0.0/1 &>/dev/null
sudo ipset add -! osi_match_all_knob 128.0.0.0/1 &>/dev/null

# use this knob to match everything if needed for rules
sudo ipset create -! osi_rules_match_all_knob hash:net &>/dev/null
sudo ipset flush -! osi_rules_match_all_knob &>/dev/null
sudo ipset add -! osi_rules_match_all_knob 0.0.0.0/1 &>/dev/null
sudo ipset add -! osi_rules_match_all_knob 128.0.0.0/1 &>/dev/null

# ipset for verified mac address and subnet, as the verify process may be async
sudo ipset create -! osi_verified_mac_set hash:mac &>/dev/null
sudo ipset create -! osi_verified_subnet_set hash:net &>/dev/null

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


# allow verified ones to passthrough
sudo iptables -w -N FR_OSI_INSPECTION &> /dev/null
sudo iptables -w -F FR_OSI_INSPECTION &> /dev/null
## knob will be turned off when policy are all applied, for now, just vpnclient
sudo iptables -w -A FR_OSI_INSPECTION -m set --match-set osi_match_all_knob src -j DROP &>/dev/null
sudo iptables -w -A FR_OSI_INSPECTION -m set --match-set osi_match_all_knob dst -j DROP &>/dev/null
sudo iptables -w -A FR_OSI_INSPECTION -m set --match-set osi_verified_mac_set src -j RETURN &>/dev/null
sudo iptables -w -A FR_OSI_INSPECTION -m set --match-set osi_verified_subnet_set src -j RETURN &>/dev/null
sudo iptables -w -A FR_OSI_INSPECTION -m set --match-set osi_verified_subnet_set dst -j RETURN &>/dev/null
sudo iptables -w -A FR_OSI_INSPECTION -j DROP &>/dev/null

# allow verified ones to passthrough
sudo iptables -w -N FR_OSI_RULES &> /dev/null
sudo iptables -w -F FR_OSI_RULES &> /dev/null

## knob will be turned off when rules are all applied
## when knob is off, all traffic should be bypassed
sudo iptables -w -A FR_OSI_RULES -m set --match-set osi_rules_match_all_knob src -j DROP &>/dev/null
sudo iptables -w -A FR_OSI_RULES -m set --match-set osi_rules_match_all_knob dst -j DROP &>/dev/null

sudo iptables -w -N FR_OSI &> /dev/null
sudo iptables -w -F FR_OSI &> /dev/null
# block inbound connection during reboot/restart
sudo iptables -w -A FR_OSI -m set --match-set osi_wan_inbound_set src,src -j DROP &>/dev/null
# only these devices are subjected to inspection
sudo iptables -w -A FR_OSI -m set --match-set osi_mac_set src -j FR_OSI_INSPECTION &>/dev/null
sudo iptables -w -A FR_OSI -m set --match-set osi_subnet_set src -j FR_OSI_INSPECTION &>/dev/null
sudo iptables -w -A FR_OSI -m set --match-set osi_subnet_set dst -j FR_OSI_INSPECTION &>/dev/null
sudo iptables -w -A FR_OSI -m set --match-set osi_rules_mac_set src -j FR_OSI_RULES &>/dev/null
sudo iptables -w -A FR_OSI -m set --match-set osi_rules_subnet_set src -j FR_OSI_RULES &>/dev/null
sudo iptables -w -A FR_OSI -m set --match-set osi_rules_subnet_set dst -j FR_OSI_RULES &>/dev/null
sudo iptables -w -C FR_FORWARD -m conntrack --ctstate NEW -j FR_OSI &> /dev/null || sudo iptables -w -A FR_FORWARD -m conntrack --ctstate NEW -j FR_OSI &> /dev/null
sudo iptables -w -C FR_INPUT -m conntrack --ctstate NEW -j FR_OSI &> /dev/null || sudo iptables -w -A FR_INPUT -m conntrack --ctstate NEW -j FR_OSI &> /dev/null


sudo ip6tables -w -t nat -N FR_PREROUTING &> /dev/null
sudo ip6tables -w -t nat -F FR_PREROUTING
sudo ip6tables -w -t nat -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo ip6tables -w -t nat -I PREROUTING -j FR_PREROUTING

sudo ip6tables -w -t nat -N FR_WIREGUARD &> /dev/null
sudo ip6tables -w -t nat -F FR_WIREGUARD

sudo ip6tables -w -t nat -N FR_POSTROUTING &> /dev/null
sudo ip6tables -w -t nat -F FR_POSTROUTING
sudo ip6tables -w -t nat -C POSTROUTING -j FR_POSTROUTING &>/dev/null || sudo ip6tables -w -t nat -I POSTROUTING -j FR_POSTROUTING

sudo ip6tables -w -t nat -N FR_PASSTHROUGH &> /dev/null
sudo ip6tables -w -t nat -F FR_PASSTHROUGH &> /dev/null
sudo ip6tables -w -t nat -A FR_POSTROUTING -j FR_PASSTHROUGH

sudo ip6tables -w -t nat -N FR_SNAT &> /dev/null
sudo ip6tables -w -t nat -F FR_SNAT &> /dev/null
sudo ip6tables -w -t nat -A FR_POSTROUTING -j FR_SNAT
sudo ip6tables -w -t nat -N FR_OUTPUT_SNAT &> /dev/null
sudo ip6tables -w -t nat -F FR_OUTPUT_SNAT &> /dev/null
sudo ip6tables -w -t nat -A FR_POSTROUTING -j FR_OUTPUT_SNAT

sudo ip6tables -w -t mangle -N FR_PREROUTING &>/dev/null
sudo ip6tables -w -t mangle -F FR_PREROUTING &>/dev/null
sudo ip6tables -w -t mangle -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -j FR_PREROUTING
# restore fwmark for packets belonging to inbound connection, this connmark is set in nat stage for inbound connection from wan
sudo ip6tables -w -t mangle -A FR_PREROUTING -m connmark ! --mark 0x0000/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
# save the updated fwmark into the connmark, which may be used in tc filter actions
sudo ip6tables -w -t mangle -A FR_PREROUTING -m mark ! --mark 0x0/0xffff -j CONNMARK --save-mark --nfmask 0xffff --ctmask 0xffff

sudo ip6tables -w -t mangle -N FR_MROUTE &>/dev/null
sudo ip6tables -w -t mangle -F FR_MROUTE &>/dev/null
sudo ip6tables -w -t mangle -C FR_PREROUTING -m addrtype --dst-type MULTICAST -m addrtype ! --src-type LOCAL -j FR_MROUTE &>/dev/null || sudo ip6tables -w -t mangle -A FR_PREROUTING -m addrtype --dst-type MULTICAST -m addrtype ! --src-type LOCAL -j FR_MROUTE

sudo ip6tables -w -t mangle -N FR_OUTPUT &> /dev/null
sudo ip6tables -w -t mangle -F FR_OUTPUT &> /dev/null
sudo ip6tables -w -t mangle -C OUTPUT -j FR_OUTPUT &>/dev/null || sudo ip6tables -w -t mangle -A OUTPUT -j FR_OUTPUT
# restore fwmark for output packets belonging to inbound connection, this connmark is set in nat stage for inbound connection from wan
sudo ip6tables -w -t mangle -A FR_OUTPUT -m connmark ! --mark 0x0000/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff

sudo ip6tables -w -N FR_INPUT &> /dev/null
sudo ip6tables -w -F FR_INPUT

# always accept loopback traffic
sudo ip6tables -w -A FR_INPUT -m addrtype --src-type LOCAL -j ACCEPT
# always accept dhcp reply from server to local
sudo ip6tables -w -A FR_INPUT -p udp --sport 547 --dport 546 -j ACCEPT
sudo ip6tables -w -A FR_INPUT -p icmpv6 --icmpv6-type neighbour-solicitation -j ACCEPT
sudo ip6tables -w -A FR_INPUT -p icmpv6 --icmpv6-type neighbour-advertisement -j ACCEPT
sudo ip6tables -w -A FR_INPUT -p icmpv6 --icmpv6-type router-advertisement -j ACCEPT

sudo ip6tables -w -C INPUT -j FR_INPUT &> /dev/null || sudo ip6tables -w -I INPUT -j FR_INPUT

# chain for icmp
sudo ip6tables -w -N FR_ICMP &> /dev/null
sudo ip6tables -w -F FR_ICMP

sudo ip6tables -w -A FR_INPUT -j FR_ICMP

# chain for wireguard
sudo ip6tables -w -N FR_WIREGUARD &> /dev/null
sudo ip6tables -w -F FR_WIREGUARD

sudo ip6tables -w -A FR_INPUT -j FR_WIREGUARD

sudo ip6tables -w -N FR_FORWARD &> /dev/null
sudo ip6tables -w -F FR_FORWARD
sudo ip6tables -w -C FORWARD -j FR_FORWARD &>/dev/null || sudo ip6tables -w -I FORWARD -j FR_FORWARD
# adjust TCP MSS for specific ethernet encapsulation, e.g., PPPoE
sudo ip6tables -w -A FR_FORWARD -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
# chain for NAT passthrough
sudo ip6tables -w -N FR_PASSTHROUGH &> /dev/null
sudo ip6tables -w -F FR_PASSTHROUGH
sudo ip6tables -w -A FR_FORWARD -j FR_PASSTHROUGH

# for mac ipset, reuse the same for iptables (v4)
sudo ipset create -! osi_subnet6_set hash:net family inet6 timeout 600 &>/dev/null
sudo ipset create -! osi_rules_subnet6_set hash:net family inet6 timeout 600 &>/dev/null
sudo ipset flush -! osi_subnet6_set &>/dev/null
sudo ipset flush -! osi_rules_subnet6_set &>/dev/null

# ipset for wan inbound block during reboot, service restart/upgrade
sudo ipset create -! osi_wan_inbound_set6 hash:net,iface family inet6 timeout 600 &>/dev/null
sudo ipset flush -! osi_wan_inbound_set6 &> /dev/null

# use this knob to match everything if needed
sudo ipset create -! osi_match_all_knob6 hash:net family inet6 &>/dev/null
sudo ipset flush -! osi_match_all_knob6 &>/dev/null
sudo ipset add -! osi_match_all_knob6 ::/1 &>/dev/null
sudo ipset add -! osi_match_all_knob6 8000::/1 &>/dev/null

# use this knob to match everything if needed for rules
sudo ipset create -! osi_rules_match_all_knob6 hash:net family inet6 &>/dev/null
sudo ipset flush -! osi_rules_match_all_knob6 &>/dev/null
sudo ipset add -! osi_rules_match_all_knob6 ::/1 &>/dev/null
sudo ipset add -! osi_rules_match_all_knob6 8000::/1 &>/dev/null

sudo ipset create -! osi_verified_subnet6_set hash:net family inet6 &>/dev/null

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

# allow verified ones to passthrough
sudo ip6tables -w -N FR_OSI_INSPECTION &> /dev/null
sudo ip6tables -w -F FR_OSI_INSPECTION &> /dev/null
## knob will be turned off when policy are all applied, for now, just vpnclient
sudo ip6tables -w -A FR_OSI_INSPECTION -m set --match-set osi_match_all_knob6 src -j DROP &>/dev/null
sudo ip6tables -w -A FR_OSI_INSPECTION -m set --match-set osi_match_all_knob6 dst -j DROP &>/dev/null
sudo ip6tables -w -A FR_OSI_INSPECTION -m set --match-set osi_verified_mac_set src -j RETURN &>/dev/null
sudo ip6tables -w -A FR_OSI_INSPECTION -m set --match-set osi_verified_subnet6_set src -j RETURN &>/dev/null
sudo ip6tables -w -A FR_OSI_INSPECTION -m set --match-set osi_verified_subnet6_set dst -j RETURN &>/dev/null
sudo ip6tables -w -A FR_OSI_INSPECTION -j DROP &>/dev/null

# allow verified ones to passthrough
sudo ip6tables -w -N FR_OSI_RULES &> /dev/null
sudo ip6tables -w -F FR_OSI_RULES &> /dev/null

## knob will be turned off when rules are all applied,
## when knob is off, all traffic should be bypassed
sudo ip6tables -w -A FR_OSI_RULES -m set --match-set osi_rules_match_all_knob6 src -j DROP &>/dev/null
sudo ip6tables -w -A FR_OSI_RULES -m set --match-set osi_rules_match_all_knob6 dst -j DROP &>/dev/null

sudo ip6tables -w -N FR_OSI &> /dev/null
sudo ip6tables -w -F FR_OSI &> /dev/null
# block inbound connection during reboot/restart
sudo ip6tables -w -A FR_OSI -m set --match-set osi_wan_inbound_set6 src,src -j DROP &>/dev/null
# only these devices are subjected to inspection
sudo ip6tables -w -A FR_OSI -m set --match-set osi_mac_set src -j FR_OSI_INSPECTION &>/dev/null
sudo ip6tables -w -A FR_OSI -m set --match-set osi_subnet6_set src -j FR_OSI_INSPECTION &>/dev/null
sudo ip6tables -w -A FR_OSI -m set --match-set osi_subnet6_set dst -j FR_OSI_INSPECTION &>/dev/null
sudo ip6tables -w -A FR_OSI -m set --match-set osi_rules_mac_set src -j FR_OSI_RULES &>/dev/null
sudo ip6tables -w -A FR_OSI -m set --match-set osi_rules_subnet6_set src -j FR_OSI_RULES &>/dev/null
sudo ip6tables -w -A FR_OSI -m set --match-set osi_rules_subnet6_set dst -j FR_OSI_RULES &>/dev/null
sudo ip6tables -w -C FR_FORWARD -m conntrack --ctstate NEW -j FR_OSI &> /dev/null || sudo ip6tables -w -A FR_FORWARD -m conntrack --ctstate NEW -j FR_OSI &> /dev/null
sudo ip6tables -w -C FR_INPUT -m conntrack --ctstate NEW -j FR_OSI &> /dev/null || sudo ip6tables -w -A FR_INPUT -m conntrack --ctstate NEW -j FR_OSI &> /dev/null


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
