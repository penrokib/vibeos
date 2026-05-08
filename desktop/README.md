# `@vibeos/desktop` — rokibrain.app

Single signed Electron desktop bundle (.dmg / .AppImage / .exe) per
[`state/rokibrain-app-v1-design-2026-05-07.md`](../../state/rokibrain-app-v1-design-2026-05-07.md).

## What this PR (M01) ships

The **shell + IPC contracts only**:

- Electron 32 + electron-vite + React 19 + Tailwind 4 scaffold.
- Process-tree skeleton:
  - `src/main/index.ts` — main process (lifecycle, tray, hotkeys, IPC, autoupdater stub).
  - `src/preload/index.ts` — `contextBridge` typed exposure to the renderer.
  - `src/renderer/` — React shell with 11 placeholder tabs.
  - `src/shared/ipc-contracts.ts` — single source of truth for channel names + payloads (importable from main, preload, renderer, and the future daemon utilityProcess).
- 11 placeholder tabs (`cockpit`, `mesh`, `drafts`, `decisions`, `knowledge`, `personas`, `prs`, `bugs`, `voice`, `connections`, `settings`).
- Tray icon with show/hide on click.
- Global hotkeys: ⌘1–⌘0 (jump to tab N), ⌘⇧V (voice), ⌘⇧P (pause-all). All fire IPC events; logic lands in later modules.
- `electron-updater` stub pointed at `https://app.rokibrain.com/releases/desktop/` (signing wired in M13).
- `build/entitlements.mac.plist` placeholder with the 5 required entitlements (microphone, network-client, network-server, files-user-selected-read-write, automation-apple-events).
- `electron-builder.yml` minimal valid config; `dist:mac|linux|win` scripts exist (will fail without certs).

## What each later wave adds

| Module | Owner | Adds |
|---|---|---|
| M02 | daemon-supervisor | `src/daemon/` utilityProcess + Supervisor (port restart policy from `apps/bridge-mac`). Real `daemon:status` + `daemon:wsPort`. |
| M03 | bff-mesh-endpoints | BFF `/ws/mesh`, `/mesh/*` routes + Prisma migration. (Out of `apps/desktop`.) |
| M04 | wa-mesh-child | `src/daemon/children/wa/` — whatsmeow wrapper + anti-ban gates. |
| M05 | tg+discord+email-mesh | `src/daemon/children/{tg,discord,email}/` siblings of M04. |
| M06 | terminal-mirror | `src/renderer/terminals/` xterm.js + `src/daemon/children/tmux/`. Replaces `cockpit` placeholder. |
| M07 | drafts+decisions UI | Replaces `drafts` + `decisions` placeholders. |
| M08 | knowledge+personas UI | Replaces `knowledge` + `personas` placeholders. |
| M09 | pr-queue+gh-shell | `src/main/gh.ts` + replaces `prs` placeholder. |
| M10 | bug-reporter | Replaces `bugs` placeholder; ports `apps/extension/src/capture.ts`. |
| M11 | voice-control | Replaces `voice` placeholder; whisper.cpp child + quickbar BrowserWindow. |
| M12 | settings+secrets | Replaces `connections` + `settings` placeholders; `src/main/secrets.ts` (Keychain via `safeStorage`). |
| M13 | build-pipeline | Completes `electron-builder.yml`, adds `afterSign`, GitHub Actions `desktop-release.yml`. |
| M14 | launchd+autostart | `build/launchd/` + install scripts. |

## Hard walls (M01 enforces; later waves preserve)

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` in **every** `BrowserWindow`. IPC only via `contextBridge`.
- Renderer never imports `node:fs`, `node:child_process`, or `electron` directly.
- All channel names live in `src/shared/ipc-contracts.ts` — do not hand-write strings elsewhere.
- Autoupdater feed URL is `https://app.rokibrain.com/releases/desktop/`. Do not point at GitHub Releases.

## Scripts

| Script | What it does |
|---|---|
| `yarn workspace @vibeos/desktop dev` | electron-vite dev server + Electron window |
| `yarn workspace @vibeos/desktop build` | Bundles main / preload / renderer to `out/` |
| `yarn workspace @vibeos/desktop type-check` | `tsc --noEmit` |
| `yarn workspace @vibeos/desktop dist:mac` | electron-builder DMG (needs Apple cert; M13) |
| `yarn workspace @vibeos/desktop dist:linux` | electron-builder AppImage |
| `yarn workspace @vibeos/desktop dist:win` | electron-builder NSIS (needs Win cert; M13) |

## Releases (M13)

### Local (no certs) — QA only

```bash
yarn workspace @vibeos/desktop dist:mac
```

Without `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK`,
`CSC_KEY_PASSWORD` in the environment:

- electron-builder skips code-signing.
- `build/notarize.js` (afterSign hook) detects the missing env, logs a warning,
  and returns cleanly.
- Output: an **unsigned** DMG at `apps/desktop/dist/rokibrain-<version>-<arch>.dmg`.
- Result: usable for local QA. macOS Gatekeeper will block double-click on
  another machine — right-click → Open works once. **NOT shippable to users.**

The same applies to `dist:linux` (AppImage is unsigned by design in v1) and
`dist:win` (unsigned NSIS triggers SmartScreen until reputation builds).

### CI (signed + notarised) — shippable

Tag a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/desktop-release.yml` then runs the matrix
`[macos-14, ubuntu-22.04, windows-2022]`. Signed/notarised DMG + AppImage +
NSIS land on a draft GitHub Release.

**Required GitHub Actions secrets** (Roki provisions — design Roki blockers
#1–#3, #7):

| Secret | Purpose |
|---|---|
| `APPLE_ID` | Apple ID for notarytool |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific pw (NOT Apple ID pw) |
| `APPLE_TEAM_ID` | 10-char Developer Team ID |
| `CSC_LINK` | base64 of Developer-ID-Application.p12 |
| `CSC_KEY_PASSWORD` | password for the .p12 |
| `WIN_CSC_LINK` | (optional) base64 of Windows EV cert .p12 |
| `WIN_CSC_KEY_PASSWORD` | (optional) password for Windows .p12 |
| `SPARKLE_ED_PRIVATE_KEY` | base64 ed25519 private key for auto-update signing |
| `GITHUB_TOKEN` | provided automatically by GH Actions |

Until those secrets land, the workflow still runs but produces unsigned
artifacts (with `::warning::` lines explaining why each step degraded).

### Sparkle / electron-updater feed

`apps/desktop/build/sparkle/feed-template.xml` is the appcast template.
The macOS job in `desktop-release.yml` fills placeholders (version, dmg url,
length, edSignature, pubDate) per tag. The artifact is uploaded to the draft
release; M15 wires rsync to the live feed at
`https://app.rokibrain.com/releases/desktop/`.
