NETWORK_SETUP=yes
NEED_FIRESTATUS=true
BLUETOOTH_TIMEOUT=3600

function get_pppoe_rps_cpus {
  echo "7"
}

function get_hostapd_path {
  # backward compatibility for old hostapd binary
  if [[ -e /usr/local/bin/hostapd ]]; then
    echo "/usr/local/bin/hostapd"
  else
    echo "/usr/sbin/hostapd"
  fi
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
    echo "release_13_0"
    ;;
  "beta_6_0")
    echo "beta_20_0"
    ;;
  "beta_7_0")
    echo "beta_21_0"
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

function before_firereset {
  # read BT MAC address from eeprom and set it to redis and /opt/bdaddr
  bt_mac=$(redis-cli -n 1 get bt_mac_address)
  if [[ -z "$bt_mac" ]]; then
    bt_mac=$(printf "%X" $((0x$(sudo xxd -u -p -l 6 -s  0x4 /dev/mtdblock2) + 3)) | sed 's/../&:/g;s/:$//')
    if [[ -z "$bt_mac" || "$bt_mac" == "00:00:00:00:00:00" ]]; then
      # generate a random BT MAC address just in case
      bt_mac=$(printf "%X" $((0x206D31000000 + 0x$(head /dev/urandom | tr -dc '0-9a-f' | head -c 6))) | sed 's/../&:/g;s/:$//')
    fi
    redis-cli -n 1 set bt_mac_address "$bt_mac"
  fi
  current_bt_mac=$(cat /opt/bdaddr)
  if [[ "$current_bt_mac" != "$bt_mac" ]]; then
    echo $bt_mac | sudo tee /opt/bdaddr /media/root-ro/opt/bdaddr
    sudo systemctl restart rtk_bt
  fi
}