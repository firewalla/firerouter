NETWORK_SETUP=yes
NEED_FIRESTATUS=true
BLUETOOTH_TIMEOUT=3600

function get_pppoe_rps_cpus {
  echo "7"
}

function get_hostapd_path {
  echo "/usr/local/bin/hostapd"
}

function get_hostapd_options {
  # orange supports hostapd -s option to log output to syslog instead of stdout
  echo "-s"
}

function get_hostapd_cli_path {
  echo "/usr/sbin/hostapd_cli"
}

function map_target_branch {
  case "$1" in
  "release_6_0")
    echo "release_9_0"
    ;;
  "beta_6_0")
    echo "beta_12_0"
    ;;
  "beta_7_0")
    echo "beta_13_0"
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

function get_wpa_supplicant_path {
  echo "wpa_supplicant"
}

function get_wpa_cli_path {
  echo "wpa_cli"
}

function get_wpa_action_script_path {
  echo "${FW_PLATFORM_CUR_DIR}/files/wpa_action.sh"
}