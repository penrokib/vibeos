# Anti-Ban + Send Pipeline — vibeOS

## The Only Send Path

Every outbound platform message **MUST** go through `SendPipeline.sendDraft()`.

**Never call `child.send()` directly** from IPC handlers, MCP tools, or any surface
other than `SendPipeline`. This is enforced by code review and architecture review.

```
Renderer Approve button
  → IPC DRAFTS_APPROVE → main/index.ts
  → daemon parentPort { kind: 'sendDraft' }
  → handleInbound → SendPipeline.sendDraft()
  → withAntiBan() → BFF counter gate
  → child.send() (e.g. WaChild)
  → wa-multi-server REST

mesh.send_draft MCP tool
  → MeshMcpServer
  → SendPipeline.sendDraft()  (same path)
```

## Anti-Ban Gates Are CODE-Enforced

The gates in `anti-ban.ts` are **always** evaluated before `child.send()`.
They are not overridable from:

- LLM prompts
- UI buttons
- MCP tool arguments
- IPC payloads

**This is a hard wall** per `feedback-wa-mcp-robust.md`.

## The Only Exception: `--unwarmed=true`

Architecture §VII.8 documents a single bypass: the `unwarmed` flag on `SendPipeline`.

When `unwarmed: true` is passed:
- The warming-cap **softwall** is relaxed (meta `unwarmed=true` is sent to BFF).
- The hard **ceiling** (absolute daily/hourly cap) is **still enforced** by BFF.
- The bypass is **always logged** at WARN level in the daemon stdout.

**When is `unwarmed` used?**
Only for freshly-paired accounts that haven't accumulated send history yet.
Never from user-facing UI. Set only at pipeline construction time by the
daemon bootstrap (e.g. when a new account is registered with an explicit flag).

## Refusal Envelopes

If a gate refuses, `SendPipeline.sendDraft()` returns:

```json
{ "status": "refused", "reason": "daily_cap_reached" }
```

The reason is:
- Posted to BFF `POST /agency/drafts/:id/refuse`
- Returned to the caller (IPC → renderer, or MCP tool result)
- Shown inline in the Drafts UI as a red badge

**Refusals are never silently swallowed.**

## Result Shapes

| Status    | Meaning                                       |
|-----------|-----------------------------------------------|
| `sent`    | Gate allowed, `child.send()` succeeded        |
| `refused` | Anti-ban gate refused (rate limit, etc.)      |
| `error`   | Account not found, send threw, or BFF unreachable |

## BFF Status Updates

After each send attempt, `SendPipeline` POSTs a status update to BFF:

| Outcome  | BFF endpoint                          |
|----------|---------------------------------------|
| Refused  | `POST /agency/drafts/:id/refuse`      |
| Sent     | `POST /agency/drafts/:id/sent`        |
| Error    | `POST /agency/drafts/:id/error`       |

These are **best-effort** — a BFF outage during status update never causes the
pipeline to throw. The send result is always returned to the caller.

## Tenant Isolation

All BFF calls include the JWT bearer token read from secrets/env.
The BFF enforces `JwtAuthGuard` + `RolesGuard` on every `/agency/drafts/*` endpoint.
Tenant scoping is handled server-side per `docs/MULTITENANCY.md`.

## Scope Cuts (v1 → v1.1)

- **Real attachments** (image/voice/file): `DraftPayload.attachments` is defined
  but `child.send()` in v1 only accepts `(recipient, text)`. Attachments are
  deferred to v1.1 when `WaChild` gains a `sendMedia()` method.
- **Non-WA children**: `SendPipeline` routes via `findChildByAccount()` which
  currently only finds `WaChild` instances. Cycle 18+ adds TG/email children.
