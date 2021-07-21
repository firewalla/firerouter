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
