#!/usr/bin/env bash
# uninstall-autostart.sh — macOS LaunchAgent uninstaller for rokibrain.app
#
# Idempotent: safe to run when nothing is installed.

set -euo pipefail

LABEL="com.rokibrain.app"
DEST_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[uninstall-autostart] not macOS; aborting." >&2
  exit 1
fi

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  echo "[uninstall-autostart] booting out ${LABEL}…"
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
else
  echo "[uninstall-autostart] no loaded service for ${LABEL} (ok)."
fi

if [[ -f "$DEST_PLIST" ]]; then
  rm -f "$DEST_PLIST"
  echo "[uninstall-autostart] removed plist: $DEST_PLIST"
else
  echo "[uninstall-autostart] no plist at $DEST_PLIST (ok)."
fi

echo "[uninstall-autostart] done."
