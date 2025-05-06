NETWORK_SETUP=yes
BLUETOOTH_TIMEOUT=3600

function run_horse_light {
  flash_interval=${1:-2}
  pause_interval=${2:-1}
  sudo pkill -9 ethtool
  for ((i=3;i>=0;i--))
  do
    sudo pkill -9 ethtool
    sudo timeout $flash_interval ethtool -p eth${i}
    sleep $pause_interval
  done
}

function get_wpa_cli_path {
  if [[ $(lsb_release -cs) == "focal" ]]; then
    echo "${FW_PLATFORM_CUR_DIR}/bin/u20/wpa_cli"
  elif [[ $(lsb_release -cs) == "jammy" ]]; then
    echo "wpa_cli" # system native
  else
    echo "${FW_PLATFORM_CUR_DIR}/bin/wpa_cli"
  fi
}

function map_target_branch {
  case "$1" in
  "release_6_0")
    echo "release_6_0"
    ;;
  "beta_6_0")
    echo "beta_6_0"
    ;;
  "beta_7_0")
    echo "beta_7_0"
    ;;
  "master")
    echo "master"
    ;;
  *)
    echo $1
    ;;
  esac
}

function get_dnsmasq_path {
  test -e /home/pi/.firewalla/run/dnsmasq && echo /home/pi/.firewalla/run/dnsmasq && return

  if [[ $(lsb_release -cs) == "jammy" ]]; then
    echo "${FW_PLATFORM_CUR_DIR}/bin/u22/dnsmasq"
  else
    echo "${FW_PLATFORM_CUR_DIR}/bin/dnsmasq"
  fi
}

function get_hostapd_path {
  if [[ $(lsb_release -cs) == "jammy" ]]; then
    echo "hostapd" # system native
  else
    echo "${FW_PLATFORM_CUR_DIR}/bin/hostapd"
  fi
}

function get_wpa_supplicant_path {
  if [[ $(lsb_release -cs) == "jammy" ]]; then
    echo "wpa_supplicant" # system native
  else
    echo "${FW_PLATFORM_CUR_DIR}/bin/wpa_supplicant"
  fi
}

function get_smcrouted_path {
  code_name=$(lsb_release -cs)
  case "$code_name" in
  "jammy")
    echo "${FW_PLATFORM_CUR_DIR}/bin/u22/smcrouted"
    ;;
  "focal")
    echo "${FW_PLATFORM_CUR_DIR}/bin/u20/smcrouted"
    ;;
  *)
    echo "${FW_PLATFORM_CUR_DIR}/bin/smcrouted"
    ;;
  esac
}

function record_eth_interfaces {
  # only record eth information if all 4 interfaces are properly detected, dummy interface is linked to /sys/devices/virtual and won't be recorded
  if [[ $(readlink -f /sys/class/net/eth{0,1,2,3} | grep -v virtual | wc -l) == "4" ]]; then
    for (( i = 0; i <= 3; i++ )); do
      pci_path=$(get_pci_path eth${i})
      mac=$(cat /sys/class/net/eth${i}/address)
      redis-cli -n 1 hset ethInfo eth${i} "{\"mac\":\"$mac\",\"pci_path\":\"$pci_path\"}"
    done
  fi
}

function remap_eth_interfaces {
  if [[ -e /sys/class/net/eth0 && -e /sys/class/net/eth1 && -e /sys/class/net/eth2 && -e /sys/class/net/eth3 ]]; then
    return
  fi
  if [[ $(redis-cli -n 1 type ethInfo) == "none" ]]; then
    return
  fi
  dummy_module_loaded=""
  for (( i = 3; i >= 0; i-- )); do
    if [[ ! -e /sys/class/net/eth${i} ]]; then
      read -r mac pci_path <<< $(redis-cli -n 1 hget ethInfo eth${i} | jq -jrc '.mac," ",.pci_path')
      if [[ -z "$mac" || -z "$pci_path" ]]; then
        return
      fi
      for (( j = i - 1; j >= 0; j-- )); do
        pci_path2=$(get_pci_path eth${j})
        if [[ -n "$pci_path2" && $pci_path == $pci_path2 ]]; then
          # a latter eth interface may substitute for a previous eth's name, need to restore its original name from redis eth info
          sudo ip link set eth${j} down
          sudo ip link set eth${j} name eth${i}
          sudo ip link set eth${i} up
          break;
        fi
      done;
      if [[ ! -e /sys/class/net/eth${i} ]]; then
        # create a dummy interface
        if [[ -z "$dummy_module_loaded" ]]; then
          sudo modprobe dummy
          dummy_module_loaded="1"
        fi
        sudo ip link add eth${i} type dummy
        sudo ip link set eth${i} address ${mac}
        sudo ip link set eth${i} up
      fi
    fi
  done;
}

function get_pci_path {
  eth=$1
  path=$(readlink -f /sys/class/net/$eth)
  pci_path=${path%"/net/$eth"}
  echo $pci_path
}
