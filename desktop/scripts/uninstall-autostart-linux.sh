#!/usr/bin/env bash
# uninstall-autostart-linux.sh — remove systemd-user unit for rokibrain.app
#
# Idempotent: safe to run when nothing is installed.

set -euo pipefail

UNIT_NAME="rokibrain-app.service"
UNIT_PATH="$HOME/.config/systemd/user/$UNIT_NAME"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[uninstall-autostart-linux] not Linux; aborting." >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
fi

if [[ -f "$UNIT_PATH" ]]; then
  rm -f "$UNIT_PATH"
  echo "[uninstall-autostart-linux] removed $UNIT_PATH"
else
  echo "[uninstall-autostart-linux] no unit at $UNIT_PATH (ok)."
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
fi

echo "[uninstall-autostart-linux] done."
