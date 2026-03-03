#!/bin/bash
# read_rt1719.sh — read RT1719 PDO voltage/current via i2c-tools

BUS=${1:-0}         # default I2C bus = 1
ADDR=${2:-0x40}     # default device address = 0x40..0x43

# Ensure i2cget exists
command -v i2cget >/dev/null 2>&1 || {
  echo "Error: i2c-tools not installed (need i2cget)."
  exit 1
}

# --- Step 1: read selected PDO index ---
sel_hex=$(i2cget -y $BUS $ADDR 0x10)
if [ $? -ne 0 ]; then
  echo "I2C read failed at 0x10"
  exit 1
fi
sel=$(( sel_hex & 0x07 ))   # 0-based index
echo "PDO_IDX=$sel"

# --- Step 2: compute base register ---
base=$(( 0x11 + 4 * ( sel - 1 ) ))
#printf "PDO%d base register: 0x%02X\n" $sel $base

# --- Step 3: read the 4 PDO bytes ---
read_byte() {
  local reg=$1
  local val=$(i2cget -y $BUS $ADDR $reg)
  echo $((val))
}

b0=$(read_byte $((base+0))) || exit 1
b1=$(read_byte $((base+1))) || exit 1
b2=$(read_byte $((base+2))) || exit 1
b3=$(read_byte $((base+3))) || exit 1

#printf "Raw bytes: b0=0x%02X b1=0x%02X b2=0x%02X b3=0x%02X\n" $b0 $b1 $b2 $b3

# --- Step 4: decode values ---
v_raw=$(( ((b2 & 0x0F) << 6) | ((b1 & 0xFC) >> 2) ))
i_raw=$(( ((b1 & 0x03) << 8) | b0 ))

voltage_mV=$(( v_raw * 50 ))   # 50 mV units
current_mA=$(( i_raw * 10 ))   # 10 mA units

echo "VOLTAGE=${voltage_mV}"
echo "CURRENT=${current_mA}"

# Optional: show power type from b3[7:6]
ptype=$(( (b3 >> 6) & 0x03 ))
case $ptype in
  0) ptname="Fixed" ;;
  1) ptname="Battery" ;;
  2) ptname="Variable" ;;
  3) ptname="PPS" ;;
esac
echo "POWER_TYPE=$ptname"
