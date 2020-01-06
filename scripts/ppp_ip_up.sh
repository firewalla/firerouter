#!/bin/bash

# parameters: interface-name tty-device speed local-IP-address remote-IP-address ipparam
INTF=$1
LOCAL_IP=$4
PEER_IP=$5

LOCAL_RT_TABLE="${INTF}_local"
DEFAULT_RT_TABLE="${INTF}_default"

sudo ip r add $LOCAL_IP dev $INTF table $LOCAL_RT_TABLE
sudo ip r add default via $PEER_IP dev $INTF table $DEFAULT_RT_TABLE

echo "nameserver $DNS1" > /etc/ppp/$INTF.resolv.conf
echo "nameserver $DNS2" >> /etc/ppp/$INTF.resolv.conf