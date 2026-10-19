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

# default to the checkout this script lives in, not to a fixed path: with a second clone around,
# a fixed default prepares that one and leaves the checkout you ran from unusable. BASH_SOURCE
# rather than $0 because this file is also sourced, and the override still wins when set
FIREROUTER_HOME=${FIREROUTER_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
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
# Ask bin/node which one that is rather than keeping a second copy of its choice here: bin/node is
# the only thing that decides, and what it decides moves (nvm's current version, the upgrade under
# .node_versions, the config/.node_legacy latch). It bumps a redis counter on every call, and that
# counter tallies FireRouter restarts, so shadow redis-cli for this one question.
shim=$(mktemp -d) || exit 1
printf '#!/bin/sh\nexit 0\n' > "$shim/redis-cli" && chmod +x "$shim/redis-cli" || exit 1
# bin/node sources nvm.sh without silencing it, so take the last line only
NODE_BIN=$(PATH="$shim:$PATH" "$FIREROUTER_HOME/bin/node" -p process.execPath 2>/dev/null | tail -n1)
rm -rf "$shim"
if [[ -z $NODE_BIN || ! -x $NODE_BIN ]]; then
  echo "bin/node did not report a usable node" >&2
  exit 1
fi

NODE_BIN_DIR=$(dirname "$NODE_BIN")
NPM_BIN_DIR=$NODE_BIN_DIR
# npm sits beside an nvm-installed node, but the upgraded one is installed as bin/node alone
# (firewalla's scripts/install_node.sh, shared with this repo). Testing for npm rather than for the
# install path keeps this free of the selection policy too. Its npm, npx and corepack come from the
# same assets tarball, unpacked next to the test tree so that install stays untouched
if [[ ! -x "$NODE_BIN_DIR/npm" ]]; then
  NODE_VERSION=$("$NODE_BIN" -v)
  NPM_DIR=$(dirname "$TEST_MODULES")/node-$NODE_VERSION
  NPM_BIN_DIR=$NPM_DIR/bin
  if [[ ! -x "$NPM_BIN_DIR/npm" ]]; then
    tarball=$(ls "${FIREWALLA_HIDDEN:-$HOME/.firewalla}"/run/assets/node-$NODE_VERSION-linux-*.tar.xz 2>/dev/null | head -n1)
    if [[ -z $tarball ]]; then
      echo "assets tarball of node $NODE_VERSION not found, cannot install npm" >&2
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
