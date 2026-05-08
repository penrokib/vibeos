# RELEASING.md — vibeOS release runbook

> Owner: Roki Hasan  
> Last updated: cycle 31

---

## Pre-flight checklist

Before tagging any release, verify:

- [ ] `CHANGELOG.md` (or GitHub milestone notes) updated with this version's changes
- [ ] Version bumped in `desktop/package.json` (`"version": "X.Y.Z"`)
- [ ] CI is green on `main` (`yarn type-check` + `yarn test` pass)
- [ ] `yarn workspace @vibeos/desktop dist:mac` runs locally without errors
  (produces an unsigned DMG when `APPLE_*` secrets are absent — that's expected)
- [ ] All GitHub repo secrets are configured (see "Required secrets" below)
- [ ] `desktop/electron-builder.yml` `appId` and `productName` match the expected values
- [ ] No uncommitted changes: `git status` is clean

---

## Required GitHub repo secrets

Go to: **GitHub → penrokib/vibeos → Settings → Secrets and variables → Actions**

### macOS signing + notarization (Apple Developer Program required)

| Secret name                  | How to get it                                                    |
| ---------------------------- | ---------------------------------------------------------------- |
| `CSC_LINK`                   | Base64-encoded `.p12` certificate from Keychain (Developer ID)  |
| `CSC_KEY_PASSWORD`           | Password for the `.p12` certificate                              |
| `APPLE_ID`                   | Your Apple ID email (used with notarytool)                       |
| `APPLE_TEAM_ID`              | 10-char string from developer.apple.com → Membership            |
| `APPLE_APP_SPECIFIC_PASSWORD`| Generate at appleid.apple.com → App-Specific Passwords          |

> **v1 note:** If any of these are missing, the workflow produces an **unsigned DMG** and emits a GitHub Actions warning — it does NOT fail the build. Unsigned DMGs trigger Gatekeeper on user machines. Remove quarantine with: `xattr -d com.apple.quarantine /Applications/rokibrain.app` (the install.sh does this automatically).

### Windows code signing (optional for v1)

| Secret name            | How to get it                                              |
| ---------------------- | ---------------------------------------------------------- |
| `WIN_CSC_LINK`         | Base64-encoded `.pfx` certificate (EV or OV code-signing)  |
| `WIN_CSC_KEY_PASSWORD` | Password for the `.pfx` certificate                        |

> **v1 note:** Without these, Windows users see a SmartScreen "Unknown publisher" warning. They can click "More info → Run anyway". SmartScreen reputation builds automatically after enough installs (~1-2k runs).

---

## Tagging a release

```bash
# 1. Make sure you're on main and it's clean
git checkout main && git pull origin main && git status

# 2. Bump version in desktop/package.json (e.g. 1.0.0)
#    Then commit:
git add desktop/package.json
git commit -m "chore: bump version to v1.0.0"
git push origin main

# 3. Tag and push
git tag v1.0.0
git push origin v1.0.0
```

The release workflow triggers automatically on the `v*` tag push.

---

## Monitoring the release

1. Go to: **GitHub → penrokib/vibeos → Actions → Release**
2. Watch the matrix build (macos-14, ubuntu-22.04, windows-2022)
3. On success, the "Publish GitHub Release" job attaches all artifacts + `SHASUMS.txt`
4. Release is visible at: **GitHub → penrokib/vibeos → Releases**

Expected artifacts after a full successful run:
- `rokibrain-arm64.dmg` — macOS Apple Silicon
- `rokibrain-x64.dmg` — macOS Intel
- `rokibrain-arm64.AppImage` — Linux arm64
- `rokibrain-x64.AppImage` — Linux x64
- `rokibrain-x64.exe` — Windows x64
- `latest-mac.yml` — electron-updater feed for macOS
- `latest-linux.yml` — electron-updater feed for Linux
- `latest.yml` — electron-updater feed for Windows
- `SHASUMS.txt` — SHA-256 checksums for all artifacts

---

## Smoke install (post-release verification)

### macOS (fresh machine or VM)

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/penrokib/vibeos/main/install.sh | bash

# Expected:
#   - Downloads rokibrain-arm64.dmg (or x64)
#   - Mounts + copies to /Applications/rokibrain.app
#   - Removes quarantine attribute
#   - Prints "vibeOS installed. Launch with: open -a rokibrain"

# Verify
ls /Applications/rokibrain.app
open -a rokibrain
```

### Linux (fresh Ubuntu 22.04)

```bash
curl -fsSL https://raw.githubusercontent.com/penrokib/vibeos/main/install.sh | bash

# Expected:
#   - Downloads rokibrain-x64.AppImage to ~/Applications/
#   - Creates symlink ~/Applications/vibeos
#   - Prints PATH export instruction

# Verify
~/Applications/vibeos --version
```

### Windows

- Download `rokibrain-x64.exe` from the GitHub Release page
- Run it (allow SmartScreen if prompted)
- Verify vibeOS appears in Start Menu

---

## BFF release proxy (Roki action item — before first release)

electron-updater fetches `latest-mac.yml` / `latest-linux.yml` / `latest.yml` from:
```
https://app.rokibrain.com/releases/desktop/
```

This proxy endpoint is defined in `electron-builder.yml`:
```yaml
publish:
  provider: generic
  url: https://app.rokibrain.com/releases/desktop/
```

**Before the first release, Roki must configure the BFF to proxy these files from GitHub Releases.** Until then, auto-update checks will fail (users can still manually update by re-running `install.sh`).

BFF proxy route to add: `GET /releases/desktop/:filename` → proxy to `https://github.com/penrokib/vibeos/releases/latest/download/:filename`

---

## Re-running a failed release

The workflow is idempotent: re-pushing the same tag (after `git tag -f` + `git push --force origin v1.0.0`) replaces existing release assets. Only do this for genuine failures, not content changes (create a new patch tag instead).

---

## Announce

After smoke-testing:

1. Tweet: "vibeOS v1.0.0 is live. One-line install: `curl -fsSL https://raw.githubusercontent.com/penrokib/vibeos/main/install.sh | bash` — run your whole business from the terminal + phone."
2. HN "Show HN": vibeOS — OSS companion app to run your business across every comms channel
3. LinkedIn post (use the `/linkedin` skill)
