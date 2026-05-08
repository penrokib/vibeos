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

## Status

This repo is being initialized from a private R&D codebase. Initial migration in progress (cycles 2-5). See [docs/ROADMAP.md](docs/ROADMAP.md) once published.

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

## License

[MIT](LICENSE) — use it for whatever, including commercial.

## Funding

vibeOS is donation-funded. If it saves you time, [sponsor](https://github.com/sponsors/penrokib) — covers Scaleway hosting for everyone.
