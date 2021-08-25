NETWORK_SETUP=yes

function get_pppoe_rps_cpus {
  echo "30"
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