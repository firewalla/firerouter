NETWORK_SETUP=yes
NEED_FIRESTATUS=true

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
    echo "release_12_0"
    ;;
  "beta_6_0")
    echo "beta_18_0"
    ;;
  "beta_7_0")
    echo "beta_19_0"
    ;;
  "master")
    echo "master"
    ;;
  *)
    echo $1
    ;;
  esac
}

function led_report_network_down {
  curl 'http://127.0.0.1:9966/fire?name=firerouter&type=network_down'
}

function led_report_network_up {
  curl 'http://127.0.0.1:9966/resolve?name=firerouter&type=network_down'
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
