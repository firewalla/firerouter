#!/bin/bash
#
# Point node_modules at a scratch tree and install everything from package.json there, so the
# committed platform/gold/node_modules (~2500 tracked files) is never written to.
#
# Recover with:  git checkout -- node_modules

mkdir -p ~/.node_modules.fr.test/node_modules
cd "$(dirname "$0")/.."
rm -f node_modules
ln -sf ~/.node_modules.fr.test/node_modules node_modules
npm install
