NETWORK_SETUP=yes
NEED_FIRESTATUS=true

function get_pppoe_rps_cpus {
  echo "7"
}

function map_target_branch {
  case "$1" in
  "release_6_0")
    echo "release_11_0"
    ;;
  "beta_6_0")
    echo "beta_16_0"
    ;;
  "beta_7_0")
    echo "beta_17_0"
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

function get_hostapd_path {
  echo "hostapd"
}

function get_wpa_supplicant_path {
  echo "wpa_supplicant"
}

function get_wpa_cli_path {
  echo "wpa_cli"
}