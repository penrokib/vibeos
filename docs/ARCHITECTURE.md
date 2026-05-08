# vibeOS — Architecture

This document distills the system design for contributors and advanced users. The [USAGE.md](USAGE.md) guide covers the user-facing side; this document covers the internals.

For multi-tenant isolation specifically, see [MULTITENANCY.md](MULTITENANCY.md) — that document is the source of truth if there is ever a conflict.

---

## Overview

vibeOS is five layers deep. From top to bottom:

```
┌─────────────────────────────────────────────────────────────────┐
│  L5  iOS / watchOS companion (Swift, apps in mobile/)           │
│      Today Digest · Drafts queue · Unified inbox                │
│      Device picker · Terminal keystroke · Voice PTT             │
└───────────────────────┬─────────────────────────────────────────┘
                        │  WebSocket + REST, TLS 1.3
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  L4  vibeos.app BFF (NestJS, Scaleway, multi-tenant)            │
│      • Device pairing + JWT issuance                            │
│      • Encrypted blob relay (cannot decrypt content)            │
│      • Push-notification dispatch (APNs/FCM, content-free)      │
│      • Plugin marketplace metadata                              │
│      • Billing / sponsor links                                  │
└───────────────────────┬─────────────────────────────────────────┘
                        │  WebSocket + REST, TLS 1.3
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  L3  vibeOS engine app (Electron, Mac/Win/Linux)                │
│      • Main process — window / tray / hotkey / IPC              │
│      • Renderer (Chromium, sandboxed) — 11 tabs                 │
│      • Daemon (utilityProcess) — supervisor, anti-ban, MCP      │
│      • Children — one OS process per account per platform       │
│      • Claude Code fleet — subprocess pool, multi-account       │
└───────────────────────┬─────────────────────────────────────────┘
                        │  MCP over ws://localhost:NNNN
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  L2  Claude Code subprocess(es)                                 │
│      • Spawned + supervised by daemon                           │
│      • Multi-account fleet (rotates per 5h Anthropic limit)     │
│      • Reads inbox + posts drafts via mesh.* MCP                │
└───────────────────────┬─────────────────────────────────────────┘
                        │  Native protocol per platform
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  L1  Provider APIs                                              │
│      WhatsApp (Baileys) · Telegram (node:telegram)              │
│      Email (imapflow + nodemailer) · Discord (discord.js)       │
│      LinkedIn (Unipile relay) · Plugins (BaseMeshChild)         │
└─────────────────────────────────────────────────────────────────┘
```

---

## The five layers in detail

### L5 — Mobile (iOS / watchOS)

Swift app (`mobile/`). Five swipeable tabs: Today, Drafts, Inbox, Devices, More. The Mac is always the engine — the phone is a read-and-approve surface. When the Mac is asleep or offline, the phone shows the last cached snapshot (read-only). Drafts approval is disabled when offline to prevent replay-order issues.

The WORK / PERSONAL toggle at the top of the screen switches the entire data view, including the encryption key set used. The two brains never share data.

### L4 — BFF (backend-for-frontend)

NestJS 11, Postgres 15 (per-tenant schema isolation), Valkey 8, BullMQ. Hosted on Scaleway.

The BFF is a **relay only**. It stores ciphertext it cannot decrypt. Subpoena-resistant by design. The BFF knows: which devices belong to a user (for push routing), and the opaque encrypted blobs (for relay). It does not know message content, contacts, or personas.

Key endpoints:

```
POST   /auth/signup                    # Email + magic link
POST   /auth/login                     # Magic link complete
POST   /auth/devices/enroll            # Pair new device, returns JWT
GET    /auth/devices                   # List user's devices
DELETE /auth/devices/:id               # Revoke device

POST   /mesh/drafts                    # Encrypted blob in
GET    /mesh/drafts?since=...          # Encrypted list out
POST   /mesh/drafts/:id/route          # Push to other devices

POST   /push/register-apns             # Register iOS device
POST   /push/dispatch                  # Daemon → BFF → APNs/FCM

GET    /plugins/registry               # Marketplace metadata
```

Multi-tenancy details: [MULTITENANCY.md](MULTITENANCY.md).

### L3 — Engine app (Electron)

The center of gravity. Three sub-components:

**Main process** owns the OS: window lifecycle, system tray, global hotkeys (⌥-Space for Voice PTT), IPC routing. It does not do any business logic.

**Renderer** (Chromium, sandboxed) shows the 11-tab UI. It has no access to `fs`, `child_process`, or `net`. Every privileged operation crosses a `contextBridge` IPC into main. This is a cardinal invariant — see below.

**Daemon** (`utilityProcess`) is where the real work happens:
- Supervises all child processes (one per account per platform)
- Enforces anti-ban gates before every outbound send
- Hosts the `mesh.*` MCP server (consumed by Claude Code)
- Manages the Claude Code subprocess fleet

### Process tree (typical full setup)

```
vibeOS.app (Electron main)
├── Renderer (Chromium, sandboxed)
├── Daemon (utilityProcess)
│   ├── Supervisor (in-process)
│   ├── Anti-ban gate (in-process)
│   ├── MCP server (in-process, ws://localhost:NNNN)
│   ├── child:wa@personal  (Baileys process)
│   ├── child:wa@business  (Baileys process)
│   ├── child:tg@roki       (node:telegram process)
│   ├── child:gmail@work    (imapflow process)
│   ├── child:discord@bot   (discord.js, v1.1)
│   ├── child:linkedin@work (Unipile relay, v1.1)
│   ├── claude-code:acct[0] (CC subprocess, account 1)
│   └── claude-code:acct[1] (CC subprocess, account 2)
└── Quickbar window (Voice PTT, hidden until ⌥-Space)
```

Memory budget: ~400 MB Electron + ~80 MB per child. Typical full install: ~1.2 GB resident.

### L2 — Claude Code subprocess fleet

The daemon spawns Claude Code (`claude` binary) as child processes. Each subprocess:
- Uses one Anthropic account
- Has a 5-hour rolling token budget tracked by the daemon
- Connects to the daemon's `mesh.*` MCP server to read inbox and post drafts
- Is rotated when it hits the limit (round-robin to next account)

This means a single `claude --dangerously-skip-permissions` invocation can read your WhatsApp, draft a reply, and post it to the drafts queue — without any manual MCP wiring. The daemon handles everything.

### L1 — Provider children

Each paired account runs as a separate OS process. This is non-negotiable: WhatsApp accounts sharing a process would let one account's crash take down another, and would expose session data across accounts. See the anti-detection rules in [SECURITY.md](SECURITY.md).

---

## MCP tool surface

The unified `mesh.*` MCP server (hosted in the daemon) exposes these tools to Claude Code:

| Tool | Purpose |
|---|---|
| `mesh.list_accounts()` | All paired accounts, platform, and status |
| `mesh.list_chats(account, limit)` | Chat list, sorted by last activity |
| `mesh.list_messages(account, chat_id, limit)` | Messages in a thread, newest first |
| `mesh.search(query, scope)` | Hybrid keyword + semantic search |
| `mesh.draft_message(account, to, text, persona)` | Create a draft; returns `draft_id` |
| `mesh.list_drafts(status?, account?)` | List drafts (pending / sent / refused / rejected) |
| `mesh.update_draft(draft_id, text)` | Refine a draft before approval |
| `mesh.send_draft(draft_id)` | Approve + send (subject to anti-ban gates) |
| `mesh.list_decisions(status?)` | Decisions queue |
| `mesh.decide(decision_id, choice, reason)` | Resolve a decision |
| `mesh.list_personas(active_only?, search?)` | Persona browser |
| `mesh.persona_outbox(persona_id, limit)` | What a persona has sent recently |
| `mesh.health()` | Daemon + children status across all devices |
| `mesh.devices()` | Devices in this user's mesh |
| `mesh.tab_send(device, tab, keys)` | Send keystrokes to a tmux pane (cc-modal hardwall enforced) |

### MCP auth

The daemon generates a JWT and writes it to:
```
~/Library/Application Support/vibeOS/mcp-token.json
```

The `vibeos-mcp` shim (installed by the app) is a thin stdio forwarder: it reads the token file and proxies to `ws://localhost:NNNN/mcp`.

Remote access: the BFF reverse-proxies the MCP socket at `wss://vibeos.app/mcp/<user-jwt>`. A Claude Code instance on a different machine gets the same tool surface.

---

## Key data flows

### Inbound message

```
Platform server → child process (native protocol)
  → child writes to local SQLite (encrypted at rest)
  → child publishes to daemon via internal WS envelope
  → Mesh tab updates (unread counter)
  → Daemon MCP surfaces the message for mesh.list_messages()
  → BFF push dispatcher: content-free APNs push to phone
  → Today Digest generator includes it in next 6h digest
```

### Outbound draft (the main loop)

```
Claude calls mesh.draft_message() or user clicks "Draft with Claude"
  → MCP server (daemon)
  → daemon → BFF: POST /mesh/drafts (encrypted)
  → BFF broadcasts to user's other devices
  → Drafts tab updates on Mac + iPhone simultaneously
  → User reviews on phone: thread context + persona reasoning
  → User taps Approve
  → renderer IPC: drafts.approve(draftId)
  → daemon: mesh.send_draft(draftId)
  → anti-ban gates run (daily cap, hourly cap, per-recipient cooldown,
    contact warming status, time-of-day window, similarity dedup)
  → gate refuses: status:refused, reason logged, Claude can read it next poll
  → gate passes: message routed to the right child via WS
  → child sends via native protocol
  → child reports success: draft.status = sent
  → Drafts tab removes row; Mesh tab shows the message in-thread
```

### Limit-prompt dismiss from phone

```
Mac: Claude Code hits limit prompt ("1: stop, 2: extra usage, 3: team plan")
  → daemon detects via tmux pane content watcher
  → daemon broadcasts {type:"limit-prompt", device, tab, options}
  → BFF push → phone wakes with banner
  → user taps "1 (stop)" — the safe option
  → phone → BFF → Mac daemon → tmux send-keys "1\n"
  → hardwall: bare "2\n" or "3\n" is REFUSED — billing change without consent
```

---

## Cardinal invariants

These are the non-negotiable rules. A PR that violates any of them is blocked.

1. **Renderer is sandboxed.** No `fs`, no `child_process`, no `net` in the renderer process. Every privileged operation crosses `contextBridge` IPC into main.

2. **Anti-ban gates live in daemon code, not in LLM prompts.** Even if Claude is instructed to bypass rate limits, the daemon refuses. The gates are enforced in `apps/desktop/src/daemon/anti-ban/`.

3. **Drafts-only by default for outbound.** All sends go through `mesh.send_draft()` which requires a human-approved `draft_id`. There is no "send immediately" path from Claude.

4. **E2E encryption (v1.1+).** The BFF stores only ciphertext. User keys never leave user devices. The relay cannot decrypt any message content.

5. **Brain split is sharp.** WORK and PERSONAL use separate SQLite databases, separate encryption keys, separate BFF push channels. No data crosses between modes.

6. **Banned bridges are refused at the plugin loader.** The daemon's `plugin-loader.ts` has a hardcoded denylist. Plugins claiming to bridge Signal, banking apps, Apple ID, government/e-sig platforms, or payment-link mutation endpoints are refused with a clear error. See [SECURITY.md](SECURITY.md) for the full list.

7. **Mac is engine, phone is window.** When the Mac is unreachable, the phone shows a read-only cached snapshot. Drafts approval is disabled while offline.

8. **Claude Code is the LLM.** vibeOS v1 has a hard dependency on Claude Code. There is no fallback to direct Anthropic API. Multi-provider is a v2 plugin.

9. **One process per account where anti-detection matters.** WhatsApp accounts never share a process. Each Baileys child has its own session file and its own daemon-mediated send path.

10. **Personal-brain firewall.** Work-mode code never writes to personal-mode storage, and vice versa, even with the same user login.

---

## Local storage layout

```
~/Library/Application Support/vibeOS/
├── token.bin                          # BFF JWT (safeStorage encrypted)
├── kek.bin                            # Key-encryption-key (macOS Keychain)
├── mcp-token.json                     # Daemon MCP JWT (rotated hourly)
├── sessions/
│   ├── wa-personal.bin                # Baileys session (per-account DEK)
│   ├── tg-roki.bin
│   └── ...
├── state/
│   ├── wa-personal.db                 # SQLite, AES-256-GCM at rest
│   ├── drafts.db                      # Drafts queue (encrypted)
│   ├── decisions.db                   # Decisions queue (encrypted)
│   ├── personas.db                    # Persona roster + outboxes
│   └── search-index/
│       ├── fts5/                      # SQLite FTS5 keyword index
│       └── lance/                     # LanceDB semantic embeddings
└── logs/                              # Per-child JSONL, 7-day rotation, no plaintext messages
```

---

## Anti-ban math

The daemon enforces these gates in order before every send. Refusal at any gate returns the message to the drafts queue with a reason. No LLM prompt can bypass them.

| Gate | WhatsApp | Telegram | Discord (bot) | Email | LinkedIn |
|---|---|---|---|---|---|
| Daily cap (warmup days 1-14) | 30 | 50 | 1000 | 100 | 20 |
| Daily cap (mature day 15+) | 80 | 200 | 10000 | 500 | 80 |
| Per-recipient cooldown | 4h (resets on inbound reply) | — | — | — | 8h |
| Burst gate | 5/min | 10/min | 100/min | 20/min | 5/min |
| Time-of-day window | 08:00-21:00 user TZ | — | — | — | 06:00-22:00 |
| Similarity dedup | <5 near-identical per 24h | — | — | — | <5 per 24h |

The only allowed relaxation is the `--unwarmed=true` flag on `mesh.draft_message()`, for established accounts with prior history being added to vibeOS. It still respects the hard ceiling (100 for WA, 100 for LI). It is logged.

---

## Search

vibeOS uses hybrid search: SQLite FTS5 for keyword/exact queries, LanceDB with `e5-small-v2` embeddings for semantic queries. Results are merged and reranked.

Search runs entirely on-device. The BFF never sees a search query or its results. Embeddings are stored encrypted at rest alongside the message databases.

Performance target: <50ms FTS5, <200ms semantic, for a 50k-message corpus.

---

## Multi-device topology

```
                  ┌─────────────┐
                  │  vibeos.app │  BFF (Scaleway)
                  │   relay     │  — encrypted blobs only
                  └──┬───┬───┬──┘
            ┌────────┘   │   └────────┐
            │            │            │
        ┌───▼────┐   ┌───▼────┐   ┌───▼────┐
        │  Mac1  │   │  Mac2  │   │ WinPC  │  User's machines
        │ vibeOS │   │ vibeOS │   │ vibeOS │
        └────┬───┘   └────────┘   └────────┘
             │ MCP local
             ▼
        ┌─────────────┐
        │ Claude Code │
        └─────────────┘

        ┌──────────┐    ┌──────────┐
        │  iPhone  │    │  Watch   │  User's mobile
        └──────────┘    └──────────┘
             │ WS (BFF relay)
             ▼ routes to chosen device
```

The iPhone shows a **device picker** at the top of the Devices tab. Tap any device to see its tabs and state. Keystrokes route through BFF → target device's daemon → tmux.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, PR process, and hard walls. For security issues, see [SECURITY.md](SECURITY.md).
