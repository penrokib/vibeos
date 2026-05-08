#!/usr/bin/env bash
# install-autostart-linux.sh — systemd-user installer for rokibrain.AppImage
#
# Writes ~/.config/systemd/user/rokibrain-app.service and enables it so
# rokibrain starts at user login.
#
# AppImage path can be overridden via $ROKIBRAIN_APP_PATH; default is
# /opt/rokibrain/rokibrain.AppImage.
#
# Idempotent: re-running rewrites the unit file and reloads the daemon.

set -euo pipefail

UNIT_NAME="rokibrain-app.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
LOG_DIR="$HOME/.local/state/rokibrain-app"

APP_PATH="${ROKIBRAIN_APP_PATH:-/opt/rokibrain/rokibrain.AppImage}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[install-autostart-linux] not Linux; aborting." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[install-autostart-linux] systemctl not found; this installer requires systemd." >&2
  exit 1
fi

if [[ ! -x "$APP_PATH" ]]; then
  echo "[install-autostart-linux] WARN: $APP_PATH is not executable yet." >&2
  echo "[install-autostart-linux] Set ROKIBRAIN_APP_PATH or place the AppImage there before first launch." >&2
fi

mkdir -p "$UNIT_DIR" "$LOG_DIR"

cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=rokibrain desktop app (autostart)
After=graphical-session.target network-online.target
Wants=graphical-session.target

[Service]
Type=simple
ExecStart=${APP_PATH} --hidden
Restart=on-failure
RestartSec=10
# Mandatory env per feedback-cron-env.md (TMUX_TMPDIR, HOME, PATH).
Environment=TMUX_TMPDIR=/tmp
Environment=HOME=%h
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin
Environment=ROKIBRAIN_BFF_URL=https://app.rokibrain.com
Environment=NODE_ENV=production
StandardOutput=append:${LOG_DIR}/stdout.log
StandardError=append:${LOG_DIR}/stderr.log

[Install]
WantedBy=default.target
UNIT

chmod 644 "$UNIT_PATH"

echo "[install-autostart-linux] wrote $UNIT_PATH"
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

if systemctl --user is-enabled "$UNIT_NAME" >/dev/null 2>&1; then
  echo "[install-autostart-linux] OK: $UNIT_NAME enabled."
  echo "[install-autostart-linux] status: systemctl --user status $UNIT_NAME"
  echo "[install-autostart-linux] logs:   tail -f $LOG_DIR/stderr.log"
else
  echo "[install-autostart-linux] WARN: enable did not stick — inspect with 'systemctl --user status $UNIT_NAME'." >&2
  exit 2
fi
