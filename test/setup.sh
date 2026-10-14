#!/bin/bash

# Usage: test/setup.sh, or "source test/setup.sh" to also put the node and npm the tests run on at the
# front of the calling shell's PATH, whether or not the test tree is already installed
if (return 0 2>/dev/null); then
  # sourced: set up in a child so its variables, exits and platform.sh stay out of this shell, and
  # take back only the PATH entries it reports on fd 3
  if test_path=$(bash "${BASH_SOURCE[0]}" 3>&1 1>&2); then
    for test_dir in $(echo "$test_path" | tr ':' ' ' | awk '{for (i = NF; i > 0; i--) print $i}'); do
      PATH=$test_dir:$(echo ":$PATH:" | sed "s#:$test_dir:#:#g; s#^:##; s#:\$##")
    done
    export PATH
    unset test_dir test_path
  else
    unset test_path
    return 1
  fi
  return 0
fi

FIREROUTER_HOME=${FIREROUTER_HOME:-$HOME/firerouter}
TEST_MODULES=/data/.node_modules.fr.test/node_modules

# written only after npm install succeeds: a failed install still leaves most packages unpacked,
# so their presence does not mean the tree is complete
INSTALLED=$TEST_MODULES/.setup_installed

# /data is owned by root; without the tree, node_modules below becomes a dangling link and npm
# fails with EEXIST trying to create it
if [[ ! -d "$TEST_MODULES" ]]; then
  sudo mkdir -p "$TEST_MODULES" && sudo chown -R pi:pi "$(dirname "$TEST_MODULES")" || exit 1
fi

# The node the FireRouter unit runs, so the tests run on the same one and pick the same mocha major.
# bin/node decides this, but it execs node and bumps a redis restart counter, so it cannot be asked
# for the path; keep the two in step. Unlike firewalla there is no per-platform get_node_bin_path -
# one wrapper serves every model.
if [[ -e /home/pi/.nvm/versions/node/v8.7.0/bin/node ]]; then
  NODE_BIN=/home/pi/.nvm/versions/node/v8.7.0/bin/node
elif [[ -d ~/.nvm ]]; then
  . ~/.nvm/nvm.sh &> /dev/null
  NODE_BIN=$(nvm which current)
else
  NODE_BIN=$(which node)
fi
NODE_UPGRADE_VERSION=v24.21.0   # must match NODE_UPGRADE_VERSION in bin/node
NODE_VERSIONS_DIR=${NODE_VERSIONS_DIR:-/home/pi/.node_versions}
NODE_UPGRADE_BIN=$NODE_VERSIONS_DIR/$NODE_UPGRADE_VERSION/bin/node
NODE_LATCH=${FIREROUTER_HIDDEN:-/home/pi/.router}/config/.node_legacy
latch=$(head -n1 "$NODE_LATCH" 2>/dev/null)
if [[ -x $NODE_UPGRADE_BIN ]] && ! [[ -e $NODE_LATCH && ( -z $latch || $latch == $NODE_UPGRADE_VERSION ) ]]; then
  NODE_BIN=$NODE_UPGRADE_BIN
fi
if [[ -z $NODE_BIN || ! -x $NODE_BIN ]]; then
  echo "no usable node found" >&2
  exit 1
fi

NODE_BIN_DIR=$(dirname "$NODE_BIN")
NPM_BIN_DIR=$NODE_BIN_DIR
# the upgraded Node is installed as bin/node only (firewalla's scripts/install_node.sh, shared with
# this repo); its npm, npx and corepack are unpacked from the same assets tarball next to the test
# tree, leaving that install untouched
if [[ $NODE_BIN == $NODE_VERSIONS_DIR/* ]]; then
  NPM_DIR=$(dirname "$TEST_MODULES")/node-$NODE_UPGRADE_VERSION
  NPM_BIN_DIR=$NPM_DIR/bin
  if [[ ! -x "$NPM_BIN_DIR/npm" ]]; then
    tarball=$(ls "${FIREWALLA_HIDDEN:-$HOME/.firewalla}"/run/assets/node-$NODE_UPGRADE_VERSION-linux-*.tar.xz 2>/dev/null | head -n1)
    if [[ -z $tarball ]]; then
      echo "assets tarball of node $NODE_UPGRADE_VERSION not found, cannot install npm" >&2
      exit 1
    fi
    top=$(basename "$tarball" .tar.xz)
    rm -rf "$NPM_DIR.tmp" && mkdir -p "$NPM_DIR.tmp" &&
      tar -xJf "$tarball" -C "$NPM_DIR.tmp" --strip-components=1 \
        "$top/bin/npm" "$top/bin/npx" "$top/bin/corepack" "$top/lib/node_modules/npm" "$top/lib/node_modules/corepack" &&
      rm -rf "$NPM_DIR" && mv "$NPM_DIR.tmp" "$NPM_DIR" || {
        echo "failed to unpack npm from $tarball" >&2
        rm -rf "$NPM_DIR.tmp"
        exit 1
      }
  fi
fi
if [[ ! -x "$NPM_BIN_DIR/npm" ]]; then
  echo "npm not found in $NPM_BIN_DIR" >&2
  exit 1
fi
TEST_PATH=$NPM_BIN_DIR
[[ $NODE_BIN_DIR != "$NPM_BIN_DIR" ]] && TEST_PATH=$TEST_PATH:$NODE_BIN_DIR
export PATH="$TEST_PATH:$PATH"

# PATH for the caller: on fd 3 when sourced, otherwise as a line to paste
report_path() {
  if { true >&3; } 2>/dev/null; then
    echo "$TEST_PATH" >&3
  else
    echo "PATH not changed (script was run, not sourced): source test/setup.sh, or export PATH=$TEST_PATH:\$PATH"
  fi
}

# already pointed at an installed test tree, so treat the environment as set up and do not reinstall;
# a link to a missing or half-installed tree falls through and is repaired
if [[ -L "$FIREROUTER_HOME/node_modules" && "$(readlink "$FIREROUTER_HOME/node_modules")" == "$TEST_MODULES" &&
      -e "$INSTALLED" ]]; then
  echo "node_modules already points at $TEST_MODULES, skipping setup"
  report_path
  exit 0
fi

cd "$FIREROUTER_HOME" || exit 1
# node_modules is a symlink to the committed platform/gold/node_modules, which is ~2500 tracked
# files; replacing a real directory here would delete it, and "ln -sf" would otherwise put the link
# inside it. Recover the committed link with:  git checkout -- node_modules
if [[ -d node_modules && ! -L node_modules ]]; then
  echo "node_modules is a real directory, refusing to replace it" >&2
  exit 1
fi
rm -f node_modules
ln -sf "$TEST_MODULES" node_modules
# npm 7 and later replace a node_modules symlink with a real directory instead of installing through
# it, so install in the tree's own directory from a copy of package.json; that also keeps
# package-lock.json out of the checkout
TEST_PREFIX=$(dirname "$TEST_MODULES")
rm -f "$INSTALLED"
cp package.json "$TEST_PREFIX/" && (cd "$TEST_PREFIX" && npm install) && touch "$INSTALLED" || exit 1
report_path
