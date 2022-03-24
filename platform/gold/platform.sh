NETWORK_SETUP=yes

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
