# vibeOS — Roadmap

This is the public roadmap. It reflects the current plan as of 2026-05-08. Dates are targets, not guarantees.

For the full architecture behind these features, see [ARCHITECTURE.md](ARCHITECTURE.md). For multi-tenant changes specifically, see [MULTITENANCY.md](MULTITENANCY.md).

---

## v1.0 — target 2026-05-22

The core loop: install on Mac, pair WhatsApp + Telegram + Email, read inbox, Claude drafts replies, you approve on phone.

### Shipped

| Cycle | Feature |
|---|---|
| 1 | Monorepo skeleton (desktop / mobile / bff / sdk / plugins) |
| 2 | Codebase migration from private R&D fork; vibeOS branding |
| 3 | Multi-tenant BFF auth — JWT, device enrollment, per-user Postgres schema |
| 4 | Row-level tenant isolation; `TenantContextService`; type-check gates |
| 5 | E2E encryption scaffold — libsodium keypair gen, device enrollment crypto, envelope API |
| 30 | Public documentation — README, USAGE, ARCHITECTURE, PLUGIN-SDK, SECURITY, CONTRIBUTING, ROADMAP, COC |

### In-flight (Waves 1-6)

**Engine (Wave 1):**
- WhatsApp child inside daemon (Baileys, per-account isolated process)
- Connections tab UI — daemon health display, pair-new wizard
- Cockpit terminal mirror renderer (xterm.js)
- Cockpit ↔ bridge-mac child wiring
- Voice PTT — whisper.cpp subprocess, ⌥-Space quickbar, audio-in-RAM-only
- Claude Code fleet manager — subprocess pool, multi-account rotation, 5h limit handling
- Today Digest generator — CC subprocess writes daily brief to `mesh.digest`
- Hybrid search — SQLite FTS5 + e5-small-v2 LanceDB embeddings

**Bridges (Wave 2 — each ends at a PAUSE for account pairing):**
- Telegram child (node:telegram)
- Email IMAP child (imapflow + nodemailer, Gmail OAuth)

**MCP + Drafts (Wave 3):**
- Unified `mesh.*` MCP server
- Drafts → daemon send wiring with full anti-ban gate path
- Compose-from-phone via persona (voice → transcript → persona refines → draft → approval)

**iOS (Wave 4):**
- Today Digest screen
- WORK / PERSONAL toggle (sharp brain-split)
- Drafts queue with full context view (Approve / Reject / Edit)
- Unified inbox
- Device picker + tabs view per device
- Terminal full keystroke send (cc-modal hardwall enforced)
- Voice PTT + push notifications (4 triggers: drafts / limit / DM / system)
- First-launch wizard (sign in → pair Mac → enable push)

**BFF + Ops (Wave 5):**
- vibeos.app k8s multi-tenant deploy (Scaleway)
- Push notification dispatcher (APNs)
- Sponsor surface (GitHub Sponsors / Open Collective links)
- Opt-in crash reporting (Sentry self-hosted, default OFF, no PII)

**Polish + Ship (Wave 6):**
- One-line installer (`curl -fsSL https://vibeos.app/install.sh | bash`)
- Final smoke walk + bug catalog
- Tag v1.0.0

---

## v1.1 — target 3-5 weeks post v1.0

**E2E encryption hardening:**
- libsodium `crypto_box` device-to-device envelope for all BFF relay blobs
- Key recovery via 24-word seed phrase
- Displayed at signup; user instructed to store offline

**Apple Watch:**
- Draft-pending count complication (large + medium)
- System health pulse complication (small, green/yellow/red)
- Watch quick-approve screen: top draft preview, Approve / Reject / Open-on-phone buttons
- Requires Apple Developer Program enrollment ($99/yr)

**New bridges:**
- Discord child (discord.js bot — NOT selfbot, which violates Discord ToS)
- LinkedIn child via Unipile relay

**Plugin SDK release:**
- `@vibeos/sdk` published to npm
- `vibeos plugin install` / `vibeos plugin list` CLI commands
- In-app marketplace browser (curated registry)
- Verified publisher badge (GPG-signed manifests)

**Other:**
- LinkedIn browser-fallback (supplement to Unipile)
- Auto-update (electron-updater + Sparkle)
- Encrypted backup to iCloud / Google Drive / S3 (user's own storage)
- Search filters (date range, account, persona)
- Postgres schema-per-tenant isolation (see [MULTITENANCY.md](MULTITENANCY.md))

---

## v1.2 — target 6-10 weeks post v1.0

- **Android** — React Native or PWA fallback
- **Wake-word** — "Hey vibe" on iOS (`SFSpeechRecognizer` continuous, default OFF)
- **Custom dashboards** — drag-drop widget layout on Mac + iPhone
- **Webhook outputs** — vibeOS events → Zapier / Make / n8n
- **i18n** — UI strings in Bahasa Indonesia and Bengali (message content is user-owned, not translated)

---

## v2 — target 3+ months post v1.0

- **Multi-LLM plugin** — swap Claude Code for OpenAI / Gemini / Ollama via a plugin interface
- **Voice synthesis** — read drafts aloud (accessibility + eyes-free use)
- **Encrypted federation** — consent-based data sharing between vibeOS users (e.g., a team sharing a persona's outbox)
- **Custom MCP plugins** — extend the `mesh.*` surface with your own tools beyond comms

---

## What we will NOT build

These are explicit non-goals. They are not on any version's roadmap.

- Multi-tenant SaaS where vibeOS-the-org can read user messages (E2E rules this out by design)
- Bridges to Signal, banking apps, Apple ID, government / e-signature platforms, or payment-link mutation endpoints (banned in plugin loader)
- Replacing Dewx, AnyHelpNow, or any specific business tool — vibeOS is the operator surface over them, not a substitute
- Custom Chromium fork (Electron's Chromium is sufficient)
- Voice synthesis in v1 (deferred to v2)

---

## Requesting features

Open a [GitHub issue](https://github.com/penrokib/vibeos/issues) with the label `roadmap-request`. Describe the use case, not just the feature. The most helpful submissions show a concrete workflow that is currently painful.
