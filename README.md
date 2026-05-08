# vibeOS

> One companion app to run your business across every comms channel — Mac engine + iPhone window + Apple Watch glance, with **Claude Code** as the on-device AI engine.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status](https://img.shields.io/badge/status-pre--alpha-orange)](https://github.com/penrokib/vibeos)

⚠️ **Pre-alpha.** Active development. v1.0 target: 2026-05-22.

## What it is

vibeOS is an OSS companion app that connects every comms channel you use — WhatsApp, Telegram, Email, Discord, LinkedIn (extensible via plugins) — into one local-first inbox, with anti-ban rate limits enforced in code, drafts-only sending by default, end-to-end encryption between your devices, and Claude Code as the on-device AI that drafts replies, generates daily digests, and acts on your behalf when you approve.

The phone is a first-class surface (60% of daily use). The Mac is the engine. Apple Watch is a glance. Claude Code is the brain. All your data stays on your devices.

## Architecture (5 layers)

```
iOS / watchOS companion          ← read + approve from anywhere
       ↕
vibeos.app BFF (encrypted relay) ← multi-tenant, can't read your data
       ↕
vibeOS engine app (Electron)     ← Mac/Win/Linux desktop
       ↕
Claude Code subprocess           ← user's own CC subscription
       ↕
Provider APIs (WA / TG / etc)    ← native protocol per platform
```

## Quick install (after v1.0)

```bash
curl -fsSL https://vibeos.app/install.sh | bash
```

This detects your OS, downloads the right binary, and walks you through:
1. Installing Claude Code (hard dependency)
2. Signing into a vibeos.app account
3. Pairing your first comms account (WhatsApp / Telegram / Email)
4. Connecting Claude Desktop via the unified `mesh.*` MCP server

## Connect Claude Code or Claude Desktop

Once installed, vibeOS exposes a single `mesh.*` MCP server on `localhost`. Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vibeos": {
      "command": "vibeos-mcp",
      "args": ["--token-file", "~/Library/Application Support/vibeOS/mcp-token.json"]
    }
  }
}
```

Restart Claude Desktop. Now Claude can:

- `mesh.list_accounts()` — see all your paired accounts
- `mesh.list_chats(account)` — browse threads
- `mesh.list_messages(account, chat)` — read any thread
- `mesh.search(query)` — hybrid keyword + semantic
- `mesh.draft_message(account, to, text, persona)` — write a draft (lands in your queue, never sends without your tap)
- `mesh.tab_send(device, tab, keys)` — send keystrokes to a tmux pane on any device (cc-modal hardwall enforced)

What Claude **cannot** do: send a message, approve its own drafts, bypass anti-ban gates, send `2`/`3` to a Claude Code limit-prompt, bridge banned platforms (Signal / banking / Apple-ID / e-sig / Stripe).

## Tabs (11 in v1)

| Tab | What it does |
|---|---|
| Cockpit | Live tmux pane mirror across your Macs/PCs |
| Mesh | Unified inbox: WA + TG + Email + Discord + LinkedIn |
| Drafts | Pending drafts from personas / Claude — Approve / Reject / Edit |
| Decisions | Persona decisions awaiting your call |
| Knowledge | Search across all knowledge bases |
| Personas | Browse + manage all your AI personas |
| PRs | GitHub PR queue (gh subprocess) |
| Bugs | One-keystroke bug reports with screenshot + console + auto-context |
| Voice | ⌥-Space push-to-talk transcription (whisper.cpp) |
| Connections | Pair / unpair accounts, see bridge health |
| Settings | Secrets, Claude Code account, telemetry opt-in, sponsor |

## Status

This repo is being built in public. See [docs/ROADMAP.md](docs/ROADMAP.md) for what ships when. Star + watch for v1.0 launch.

## Repository layout (monorepo)

| Workspace | Purpose |
|---|---|
| `desktop/` | Electron app (Mac/Win/Linux) — main, renderer, daemon, children |
| `mobile/` | iOS / watchOS Swift companion (extends existing `apps/ios`) |
| `bff/` | NestJS multi-tenant BFF (Scaleway, encrypted blob relay) |
| `sdk/` | `@vibeos/sdk` — `BaseMeshChild` contract for plugin authors |
| `plugins/` | Bundled + community plugins (each its own npm package) |
| `docs/` | User docs, plugin SDK guide, contributor guide |

## Development

Once cycle 3 ships:

```bash
git clone https://github.com/penrokib/vibeos
cd vibeos
yarn install
yarn workspace @vibeos/desktop dev   # boots Electron app + daemon
```

## Documentation

- [USAGE.md](docs/USAGE.md) — install + first-launch + daily-use guide
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — 5-layer architecture + cardinal invariants
- [PLUGIN-SDK.md](docs/PLUGIN-SDK.md) — write your own bridge plugin
- [SECURITY.md](docs/SECURITY.md) — threat model + responsible disclosure
- [MULTITENANCY.md](docs/MULTITENANCY.md) — tenant isolation rules
- [ROADMAP.md](docs/ROADMAP.md) — v1 / v1.1 / v1.2 / v2 plans
- [CONTRIBUTING.md](docs/CONTRIBUTING.md) — how to contribute
- [RELEASING.md](docs/RELEASING.md) — release runbook
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards

## Hardwalls (read before contributing)

vibeOS has a small set of non-negotiable invariants:

1. NEVER auto-send any message — drafts-only by default, every send needs explicit user approval
2. NEVER bypass anti-ban gates — they live in code, not LLM prompts
3. NEVER bridge: Signal, banking apps, Apple ID, government / e-sig, Stripe checkout
4. NEVER persist plaintext secrets to disk
5. NEVER let renderer access fs / child_process / net directly
6. NEVER auto-send `2` / `3` + Enter to a Claude Code limit-prompt — that's a billing change

Full list in [ARCHITECTURE.md §Cardinal Invariants](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE) — use it for whatever, including commercial.

## Funding

vibeOS is donation-funded. If it saves you time:

- [GitHub Sponsors](https://github.com/sponsors/penrokib)
- [Patreon](https://patreon.com/penrokib)
- [Open Collective](https://opencollective.com/vibeos)

Sponsorship covers infra hosting + future v1.1 features (Apple Watch, plugin marketplace, Android).
