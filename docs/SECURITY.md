# vibeOS — Security

This document covers the threat model, what vibeOS protects against (and what it does not), the key hierarchy, and responsible disclosure.

For the architecture decisions behind these choices, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Threat model

### What vibeOS protects against

**Network attackers (hostile WiFi, MITM)**
All traffic between devices and the vibeos.app BFF uses TLS 1.3 with certificate pinning. A network attacker who intercepts traffic sees only ciphertext.

**The vibeOS relay operator (vibeos.app BFF)**
The BFF stores only encrypted blobs. It cannot decrypt message content, draft text, contact lists, or persona data. The BFF knows: which device IDs belong to a user, and opaque ciphertext to relay between them. This design means a subpoena of the BFF yields no user content.

**Disk theft**
All local storage is AES-256-GCM encrypted. The key-encryption-key (KEK) is stored in macOS Keychain, protected by the user's login password and Touch ID. Without the KEK, the encrypted databases are opaque.

**Compromised child process**
Each platform bridge (WhatsApp, Telegram, Email, etc.) runs as an isolated OS process. It can only access its own session database. The daemon mediates all upstream communication. A compromised WhatsApp child cannot read the Telegram session.

**Compromised renderer**
The Electron renderer runs with `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`. The renderer cannot access the filesystem, spawn processes, or make network requests directly. Every privileged operation crosses `contextBridge` IPC into the main process, which validates the request.

**Malicious plugin (v1.1+)**
Plugins run as isolated processes. The daemon mediates all their access. Starting in v1.1, the plugin marketplace shows a "Verified publisher" badge for GPG-signed plugins. Users who install unsigned plugins see a one-time risk warning. In v2, signing will be mandatory for marketplace listings.

---

### What vibeOS does NOT protect against

**Compromised user device with physical access and Touch ID bypass**
If an attacker has your unlocked Mac and can authenticate as you (e.g., your face/fingerprint), they can access the Keychain and decrypt local storage. This is inherent to any local-first app.

**Compromised Anthropic / Claude Code**
vibeOS trusts Claude Code as its AI engine. If the Claude binary or Anthropic's servers were compromised, a malicious Claude could craft drafts that manipulate the user. vibeOS's drafts-only-by-default model limits blast radius: Claude cannot auto-send, only post drafts for human approval.

**Provider-side surveillance**
WhatsApp messages are encrypted between your device and Meta's servers, but Meta can read them server-side. This is inherent to WhatsApp's architecture. vibeOS does not (and cannot) change this. If end-to-end privacy from the provider is your requirement, use Signal — which vibeOS intentionally does not bridge.

**Social engineering of the user**
vibeOS cannot protect you from approving a malicious draft. The Drafts UI shows full thread context and persona reasoning to help you evaluate each draft, but the final judgment is yours.

---

## Key hierarchy (v1.1+)

```
User signup
  → Generate device keypair (libsodium x25519) → stored in Keychain
  → BFF receives only the public key

On 2nd device pair
  → New keypair generated on device 2
  → Device 1 encrypts "user master key" (UMK) for device 2's public key
  → Exchange via QR code or 6-digit short code shown by device 1
  → Device 2 decrypts and stores UMK in its Keychain

Message / draft storage
  → Per-blob key derived from UMK
  → Blob encrypted with recipient device public keys
  → BFF sees: [device_id → ciphertext] pairs, nothing else

Key recovery
  → At signup: a 24-word BIP39 seed phrase is shown once
  → User is instructed to write it down and store it offline
  → If all devices are lost: seed phrase decrypts a recovery blob stored at BFF
  → Without the seed phrase, there is no recovery path
```

**v1 note:** v1 ships TLS-only (no client-side E2E). The BFF can read blob content in v1. E2E encryption hardens to the above model in v1.1. This trade-off was made to hit the v1.0 ship date. The v1 README and first-launch wizard state this clearly.

---

## Banned platforms

The plugin loader (`apps/desktop/src/daemon/plugin-loader.ts`) enforces a hardcoded denylist. Plugins claiming to bridge any of the following are refused at install with an error message and cannot be loaded:

```
signal
banking
apple-id
google-account
government
e-sign
docusign
hellosign
stripe-checkout
paypal-pay
lemon-squeezy-pay
```

**Rationale:**
- **Signal**: bridging defeats Signal's E2E guarantee and violates its ToS
- **Banking**: financial data requires regulatory controls vibeOS does not implement
- **Apple ID / Google account**: these are identity providers, not comms platforms; bridging creates credential theft surface
- **Government / e-sign**: legal documents require audit trails that vibeOS's ephemeral-relay model cannot provide
- **Payment mutation endpoints**: sending money or generating payment links without explicit payment-app UX is a fraud vector

This list is not configurable by users, plugins, or LLM prompts.

---

## Anti-ban enforcement

Rate-limit gates live in daemon code (`apps/desktop/src/daemon/anti-ban/`). They are not enforced via LLM prompts. Even if Claude is instructed to bypass rate limits, the daemon refuses.

See [ARCHITECTURE.md#anti-ban-math](ARCHITECTURE.md#anti-ban-math) for the per-platform caps and gate logic.

---

## Responsible disclosure

If you find a security vulnerability in vibeOS, please do not open a public GitHub issue. Instead:

**Email:** security@vibeos.app

Include:
- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Your suggested fix (optional but appreciated)

We will acknowledge your report within 48 hours and aim to ship a fix within 14 days for critical issues. We will credit you in the release notes unless you prefer to remain anonymous.

**Scope:**
- vibeOS desktop app (Electron, daemon, children)
- vibeOS BFF (vibeos.app)
- vibeOS iOS / watchOS companion
- `@vibeos/sdk` and bundled plugins

**Out of scope:**
- Vulnerabilities in Claude Code / Anthropic's infrastructure
- Vulnerabilities in platform providers (WhatsApp, Telegram, etc.)
- Social engineering attacks
- Attacks requiring physical access to an unlocked device

---

## Hall of fame

*Empty — waiting for our first responsible disclosure. Your name could be here.*

---

## Security hardening checklist for contributors

Before submitting a PR that touches security-sensitive code:

- [ ] Renderer: no `nodeIntegration`, no direct `fs`/`net`/`child_process` access, all ops via `contextBridge`
- [ ] Secrets: `ctx.storeSecret()` / Keychain only — no plaintext secrets on disk or in logs
- [ ] Voice audio: RAM only during transcription — never written to disk
- [ ] Banned platforms: denylist in `plugin-loader.ts` is unchanged (or additions only)
- [ ] Anti-ban gates: daemon-code only — no gate bypass via LLM prompt possible
- [ ] Drafts: no auto-send path — every send requires an approved `draft_id`
- [ ] Tenant isolation: every Prisma query on a tenant-scoped table includes `where: { tenantId }` (see [MULTITENANCY.md](MULTITENANCY.md))
- [ ] Logs: no plaintext message content in log files (per-child JSONL, redacted)
- [ ] cc-modal hardwall: `mesh.tab_send()` refuses bare "2\n" or "3\n" to a Claude Code session
