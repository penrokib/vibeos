#!/usr/bin/env bash
# install-autostart.sh — macOS LaunchAgent installer for rokibrain.app
#
# Installs a user-scope LaunchAgent at ~/Library/LaunchAgents/com.rokibrain.app.plist
# so rokibrain.app starts hidden at login.
#
# Idempotent: running twice leaves a single LaunchAgent (boots out the old
# service first if loaded, overwrites the plist, then bootstraps cleanly).
#
# Hard rules honored:
# - User scope ONLY (~/Library/LaunchAgents). Never /Library/LaunchDaemons.
# - Mandatory env vars TMUX_TMPDIR=/tmp, HOME, PATH baked into plist (per
#   feedback-cron-env.md).
# - $USER expanded at install time; no hardcoded paths in the source plist.

set -euo pipefail

LABEL="com.rokibrain.app"
SRC_PLIST_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build/launchd/${LABEL}.plist"
SRC_PLIST="${ROKIBRAIN_PLIST_SRC:-$SRC_PLIST_DEFAULT}"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST_PLIST="$DEST_DIR/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/rokibrain-app"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[install-autostart] not macOS; aborting." >&2
  exit 1
fi

if [[ ! -f "$SRC_PLIST" ]]; then
  echo "[install-autostart] source plist not found: $SRC_PLIST" >&2
  exit 1
fi

echo "[install-autostart] user=$USER uid=$UID_NUM"
echo "[install-autostart] source plist: $SRC_PLIST"
echo "[install-autostart] target:       $DEST_PLIST"

mkdir -p "$DEST_DIR" "$LOG_DIR"

# Boot out any previously loaded agent (idempotency: ignore failure if missing).
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  echo "[install-autostart] booting out existing service…"
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
fi

# Expand __USER__ placeholder in the source plist into the destination.
# We use a temp file so an interrupted write never leaves a half-written plist.
TMP_PLIST="$(mktemp -t rokibrain-app-plist.XXXXXX)"
trap 'rm -f "$TMP_PLIST"' EXIT
sed "s|__USER__|${USER}|g" "$SRC_PLIST" > "$TMP_PLIST"

# Lint the expanded plist before installing.
plutil -lint "$TMP_PLIST" >/dev/null

mv "$TMP_PLIST" "$DEST_PLIST"
trap - EXIT
chmod 644 "$DEST_PLIST"

echo "[install-autostart] bootstrapping LaunchAgent…"
launchctl bootstrap "$DOMAIN" "$DEST_PLIST"

# Verify.
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  echo "[install-autostart] OK: ${LABEL} is loaded in $DOMAIN."
  echo "[install-autostart] inspect: launchctl print ${DOMAIN}/${LABEL}"
  echo "[install-autostart] logs:    tail -f $LOG_DIR/launchd-stderr.log"
else
  echo "[install-autostart] WARN: bootstrap appeared to succeed but service not visible." >&2
  echo "[install-autostart] On macOS Sequoia (15+) you may need to approve the Login Item:" >&2
  echo "  System Settings -> General -> Login Items & Extensions -> Open at Login -> enable rokibrain" >&2
  exit 2
fi
