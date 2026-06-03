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
#   2. pick system-native vs bundled binaries by Ubuntu release (same rule as the
#      other x86_64 boards, needed for libc compatibility on jammy)
#
# Binaries themselves (dnsmasq/hostapd/wpa_*/smcrouted/...) are byte-identical
# x86_64 builds, so platform/crystal/bin is a symlink to gold's bin. Replace that
# symlink with real files the day Crystal needs its own binaries — nothing here
# has to change.

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

# --- binary selection: system-native on jammy, bundled otherwise --------------
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

function get_wpa_cli_path {
  if [[ $(lsb_release -cs) == "focal" ]]; then
    echo "${FW_PLATFORM_CUR_DIR}/bin/u20/wpa_cli"
  elif [[ $(lsb_release -cs) == "jammy" ]]; then
    echo "wpa_cli" # system native
  else
    echo "${FW_PLATFORM_CUR_DIR}/bin/wpa_cli"
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
