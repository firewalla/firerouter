#!/bin/bash

: ${FIREROUTER_HOME:=/home/pi/firerouter}

DEB_FILE="${FIREROUTER_HOME}/platform/files/cacert/ca-certificates_all.deb"

if [[ ! -f "$DEB_FILE" ]]; then
  logger -t fireboot "update_ca_certificates: deb package not found: $DEB_FILE"
  exit 0
fi

TARGET_VERSION=$(dpkg-deb -f "$DEB_FILE" Version 2>/dev/null)
INSTALLED_VERSION=$(dpkg-query -W -f='${Version}' ca-certificates 2>/dev/null)

# Only upgrade when ca-certificates is missing or installed version is older
if [[ -n "$INSTALLED_VERSION" ]] && ! dpkg --compare-versions "$INSTALLED_VERSION" lt "$TARGET_VERSION"; then
  exit 0
fi

if sudo dpkg -i "$DEB_FILE" >/dev/null; then
  logger -t fireboot "update_ca_certificates: upgraded ca-certificates from ${INSTALLED_VERSION:-none} to $TARGET_VERSION"
  exit 0
else
  logger -t fireboot "update_ca_certificates: ERROR failed to upgrade ca-certificates to $TARGET_VERSION"
  exit 1
fi

exit 0
