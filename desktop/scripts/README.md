# rokibrain.app autostart scripts (M14)

User-scope autostart installers for the rokibrain Electron desktop app.
The app launches with `--hidden` so the window stays out of the way until
the user clicks the tray/menubar icon.

> **Scope discipline.** All three OS installers write to **user scope only**
> (LaunchAgent, systemd `--user`, per-user Startup folder). They never write
> to system-wide locations such as `/Library/LaunchDaemons/`,
> `/etc/systemd/system/`, or `HKLM\...\Run`.

## macOS

| Action    | Command |
|-----------|---------|
| Install   | `bash apps/desktop/scripts/install-autostart.sh` |
| Uninstall | `bash apps/desktop/scripts/uninstall-autostart.sh` |
| Verify    | `launchctl print gui/$(id -u)/com.rokibrain.app` |
| Logs      | `tail -f ~/Library/Logs/rokibrain-app/launchd-stderr.log` |

What the installer does:

1. Expands the `__USER__` placeholder in `build/launchd/com.rokibrain.app.plist`
   into `$USER` and writes the result to `~/Library/LaunchAgents/com.rokibrain.app.plist`.
2. `launchctl bootout` any prior copy (idempotent), then `launchctl bootstrap
   gui/$(id -u)` the new plist.
3. Verifies the service is loaded via `launchctl print`.

The plist sets `RunAtLoad=true`, `KeepAlive` only on `Crashed` /
`SuccessfulExit=false`, `ThrottleInterval=10`, `ProcessType=Interactive`, and
the mandatory env triple `TMUX_TMPDIR=/tmp`, `HOME`, `PATH=/opt/homebrew/bin:...`
required by the cron-env hard rule.

### macOS Sequoia (15+) "Operation not permitted"

Sequoia tightened Login Items: `launchctl bootstrap` can succeed but the
agent stays gated until the user grants the Login Item once. If the
installer prints `WARN: bootstrap appeared to succeed but service not visible`,
or you see `Operation not permitted` in stderr:

1. Open **System Settings → General → Login Items & Extensions**.
2. Under **Open at Login**, find `rokibrain` and toggle it **on**.
3. (If it is missing entirely, launch `rokibrain.app` once manually so macOS
   registers it as a known app, then re-run the installer.)

### Override the source plist

`ROKIBRAIN_PLIST_SRC=/path/to/com.rokibrain.app.plist bash install-autostart.sh`

## Linux

| Action    | Command |
|-----------|---------|
| Install   | `bash apps/desktop/scripts/install-autostart-linux.sh` |
| Uninstall | `bash apps/desktop/scripts/uninstall-autostart-linux.sh` |
| Verify    | `systemctl --user status rokibrain-app.service` |
| Logs      | `tail -f ~/.local/state/rokibrain-app/stderr.log` |

The installer writes `~/.config/systemd/user/rokibrain-app.service`,
runs `systemctl --user daemon-reload` and `systemctl --user enable --now`.
The unit calls `<AppImage path> --hidden` and bakes the same env vars
(`TMUX_TMPDIR=/tmp`, `HOME=%h`, `PATH=/usr/local/bin:/usr/bin:/bin:...`).

Override the AppImage path:

```bash
ROKIBRAIN_APP_PATH=/home/me/Apps/rokibrain.AppImage \
  bash apps/desktop/scripts/install-autostart-linux.sh
```

If the unit fails to start, inspect with `journalctl --user -u rokibrain-app.service`.
On distros without lingering enabled, the user service only runs while you are
logged in — `loginctl enable-linger $USER` (one-time, requires sudo) makes it
start at boot regardless of login.

## Windows

Run from PowerShell 7+ (`pwsh`) or Windows PowerShell 5.1:

| Action    | Command |
|-----------|---------|
| Install   | `pwsh -NoProfile -File apps\desktop\scripts\install-autostart.ps1` |
| Uninstall | `pwsh -NoProfile -File apps\desktop\scripts\uninstall-autostart.ps1` |
| Verify    | `Get-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\rokibrain.lnk"` |

The installer creates `rokibrain.lnk` in the per-user Startup folder pointing
at `%ProgramFiles%\rokibrain\rokibrain.exe --hidden` (override with
`-ExePath`). Idempotent — re-running replaces the existing shortcut. No admin
rights required.

## Idempotency contract (all OSes)

Running the installer twice in a row leaves exactly one autostart entry — no
duplicate LaunchAgents, no duplicate systemd units, no duplicate Startup
shortcuts. Uninstall scripts succeed silently when nothing is installed.

## Files

| File | Purpose |
|------|---------|
| `../build/launchd/com.rokibrain.app.plist` | macOS LaunchAgent template (with `__USER__` placeholder) |
| `install-autostart.sh` / `uninstall-autostart.sh` | macOS install / uninstall |
| `install-autostart-linux.sh` / `uninstall-autostart-linux.sh` | Linux systemd-user install / uninstall |
| `install-autostart.ps1` / `uninstall-autostart.ps1` | Windows Startup shortcut install / uninstall |
