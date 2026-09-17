# Crystal platform shell config (firerouter side)
#
# Crystal is its own product series, independent from gold. This file is fully
# self-contained: it does NOT source gold's platform.sh, so changes to gold can
# never silently change Crystal's behavior.
#
# The base dispatcher (platform/platform.sh) defines sensible defaults for most
# helpers (get_dhcpcd_path, get_firereset_path, get_ndppd_path,
# get_node_modules_dir, record/remap_eth_interfaces, before_firereset, ...) and
# then sources this file, so we only override what is genuinely Crystal-specific:
#   1. no status LEDs  -> LED / horse-light helpers are no-ops, firestatus off
#   2. binary selection: Crystal only ever ships on Ubuntu 26.04, so the helpers
#      below pick one path unconditionally instead of branching on lsb_release
#
# Binaries themselves (dnsmasq/hostapd/wpa_*/smcrouted/...) are byte-identical
# x86_64 builds, so platform/crystal/bin is a real directory whose entries are
# per-file symlinks into gold's bin. Drop an entry Crystal does not need, or
# replace a symlink with a real file the day Crystal needs its own build —
# nothing here has to change.

# Crystal has no status LEDs, so the firestatus LED daemon is not needed.
NEED_FIRESTATUS=false

# --- no LEDs on Crystal -------------------------------------------------------
function run_horse_light {
  return
}

function led_report_network_down {
  return
}

function led_report_network_up {
  return
}

# --- binary selection --------------------------------------------------------
# Crystal only ships on Ubuntu 26.04, so unlike gold/goldpro there is no
# lsb_release branching here: the focal/jammy arms never matched anyway, these
# are the paths Crystal has always resolved to.

function get_dnsmasq_path {
  test -e /home/pi/.firewalla/run/dnsmasq && echo /home/pi/.firewalla/run/dnsmasq && return

  echo "${FW_PLATFORM_CUR_DIR}/bin/dnsmasq"
}

function get_hostapd_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/hostapd"
}

function get_wpa_supplicant_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/wpa_supplicant"
}

function get_wpa_cli_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/wpa_cli"
}

function get_smcrouted_path {
  echo "${FW_PLATFORM_CUR_DIR}/bin/u22/smcrouted"
}

function map_target_branch {
  case "$1" in
  "release_6_0")
    echo "release_15_0"
    ;;
  "beta_6_0")
    echo "beta_24_0"
    ;;
  "beta_7_0")
    echo "beta_25_0"
    ;;
  "master")
    echo "master"
    ;;
  *)
    echo $1
    ;;
  esac
}
