#!/bin/bash

# ------ initialize iptables chains
sudo iptables -w -t nat -N FR_PREROUTING &> /dev/null
sudo iptables -w -t nat -F FR_PREROUTING
sudo iptables -w -t nat -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo iptables -w -t nat -I PREROUTING -j FR_PREROUTING

sudo iptables -w -t nat -N FR_UPNP &> /dev/null
sudo iptables -w -t nat -F FR_UPNP
sudo iptables -w -t nat -A FR_PREROUTING -j FR_UPNP

sudo iptables -w -t nat -N FR_POSTROUTING &> /dev/null
sudo iptables -w -t nat -F FR_POSTROUTING
sudo iptables -w -t nat -C POSTROUTING -j FR_POSTROUTING &>/dev/null || sudo iptables -w -t nat -I POSTROUTING -j FR_POSTROUTING

sudo iptables -w -t nat -N FR_PASSTHROUGH &> /dev/null
sudo iptables -w -t nat -F FR_PASSTHROUGH &> /dev/null
sudo iptables -w -t nat -A FR_POSTROUTING -j FR_PASSTHROUGH

sudo iptables -w -t nat -N FR_SNAT &> /dev/null
sudo iptables -w -t nat -F FR_SNAT &> /dev/null
sudo iptables -w -t nat -A FR_POSTROUTING -j FR_SNAT

sudo iptables -w -N FR_FORWARD &> /dev/null
sudo iptables -w -F FR_FORWARD
sudo iptables -w -C FORWARD -j FR_FORWARD &>/dev/null || sudo iptables -w -I FORWARD -j FR_FORWARD
# adjust TCP MSS for specific ethernet encapsulation, e.g., PPPoE
sudo iptables -w -A FR_FORWARD -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
# chain for NAT passthrough
sudo iptables -w -N FR_PASSTHROUGH &> /dev/null
sudo iptables -w -F FR_PASSTHROUGH
sudo iptables -w -A FR_FORWARD -j FR_PASSTHROUGH

sudo ip6tables -w -t nat -N FR_PREROUTING &> /dev/null
sudo ip6tables -w -t nat -F FR_PREROUTING
sudo ip6tables -w -t nat -C PREROUTING -j FR_PREROUTING &>/dev/null || sudo ip6tables -w -t nat -I PREROUTING -j FR_PREROUTING

sudo ip6tables -w -t nat -N FR_UPNP &> /dev/null
sudo ip6tables -w -t nat -F FR_UPNP
sudo ip6tables -w -t nat -A FR_PREROUTING -j FR_UPNP

sudo ip6tables -w -t nat -N FR_POSTROUTING &> /dev/null
sudo ip6tables -w -t nat -F FR_POSTROUTING
sudo ip6tables -w -t nat -C POSTROUTING -j FR_POSTROUTING &>/dev/null || sudo ip6tables -w -t nat -I POSTROUTING -j FR_POSTROUTING

sudo ip6tables -w -t nat -N FR_PASSTHROUGH &> /dev/null
sudo ip6tables -w -t nat -F FR_PASSTHROUGH &> /dev/null
sudo ip6tables -w -t nat -A FR_POSTROUTING -j FR_PASSTHROUGH

sudo ip6tables -w -t nat -N FR_SNAT &> /dev/null
sudo ip6tables -w -t nat -F FR_SNAT &> /dev/null
sudo ip6tables -w -t nat -A FR_POSTROUTING -j FR_SNAT

sudo ip6tables -w -N FR_FORWARD &> /dev/null
sudo ip6tables -w -F FR_FORWARD
sudo ip6tables -w -C FORWARD -j FR_FORWARD &>/dev/null || sudo ip6tables -w -I FORWARD -j FR_FORWARD
# adjust TCP MSS for specific ethernet encapsulation, e.g., PPPoE
sudo ip6tables -w -A FR_FORWARD -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
# chain for NAT passthrough
sudo ip6tables -w -N FR_PASSTHROUGH &> /dev/null
sudo ip6tables -w -F FR_PASSTHROUGH
sudo ip6tables -w -A FR_FORWARD -j FR_PASSTHROUGH


# ------ flush routing tables
sudo ip r flush table global_local
sudo ip r flush table global_default
sudo ip r flush table wan_routable
sudo ip r flush table lan_routable
sudo ip r flush table static

sudo ip -6 r flush table global_local
sudo ip -6 r flush table global_default
sudo ip -6 r flush table wan_routable
sudo ip -6 r flush table lan_routable
sudo ip -6 r flush table static

# ------ initialize ip rules
# do not touch ip rules created by Firewalla
rules_to_remove=`ip rule list | grep -v -e "^6000:" | cut -d: -f2-`;
while IFS= read -r line; do
  sudo ip rule del $line
done <<< "$rules_to_remove"
sudo ip rule add pref 0 from all lookup local
sudo ip rule add pref 32766 from all lookup main
sudo ip rule add pref 32767 from all lookup default

sudo ip rule add pref 3000 from all lookup global_local
sudo ip rule add pref 4001 from all lookup static

rules_to_remove=`ip -6 rule list | grep -v -e "^6000:" | cut -d: -f2-`;
while IFS= read -r line; do
  sudo ip -6 rule del $line
done <<< "$rules_to_remove"
sudo ip -6 rule add pref 0 from all lookup local
sudo ip -6 rule add pref 32766 from all lookup main
sudo ip -6 rule add pref 32767 from all lookup default

sudo ip -6 rule add pref 3000 from all lookup global_local
sudo ip -6 rule add pref 4001 from all lookup static

