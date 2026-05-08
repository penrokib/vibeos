# Contributing to vibeOS

Thank you for your interest in contributing. vibeOS is MIT-licensed and community-funded. Every contribution — bug fix, plugin, doc improvement, or test — is welcome.

Please read this guide before opening a PR. It will save you time.

---

## Code of conduct

All contributors are expected to follow the [Contributor Covenant 2.1](../CODE_OF_CONDUCT.md). Be respectful, assume good intent, and keep discussion focused on the work.

---

## Development setup

**Requirements:**
- macOS 13+ (Linux/Windows work for BFF development; the Electron app requires Mac for full testing)
- Node.js 20+
- Yarn 4 (`corepack enable` then `corepack prepare yarn@stable --activate`)
- [Claude Code](https://claude.ai/code) installed and authenticated — the fleet manager and MCP tests require it
- Git 2.40+

**Clone and install:**

```bash
git clone https://github.com/penrokib/vibeos
cd vibeos
yarn install
```

**Start the desktop app (Electron + daemon + renderer):**

```bash
yarn workspace @vibeos/desktop dev
```

**Start the BFF (NestJS):**

```bash
# Copy the example env
cp bff/.env.example bff/.env
# Edit bff/.env — fill in DATABASE_URL and JWT_SECRET at minimum

yarn workspace @vibeos/bff dev
```

**Run all type checks:**

```bash
yarn type-check
```

**Run tests:**

```bash
yarn test          # jest (BFF) + vitest (desktop renderer)
```

Both must pass before a PR is mergeable.

---

## Where to start

### Good first issues

Look for issues labeled [`good-first-issue`](https://github.com/penrokib/vibeos/labels/good-first-issue) on GitHub. These are self-contained, well-scoped, and have clear acceptance criteria.

### Plugin authorship

The fastest way to contribute value is to build a plugin for a platform you use. See [PLUGIN-SDK.md](PLUGIN-SDK.md) for the full guide. Plugin development does not require any knowledge of Electron internals.

### Documentation

Docs live in `docs/`. If you find something unclear, open a PR to fix it. Documentation PRs are merged quickly.

### Bug reports

Open a GitHub issue. Use the bug report template. Include:
- OS version and vibeOS version (`vibeOS → About`)
- Steps to reproduce
- What you expected vs what happened
- Console logs if relevant (Settings → Developer → Export Logs)

---

## PR process

### One concern per PR

Each PR should do one thing. "Fix X" or "Add Y" — not both. Small PRs ship faster, get better reviews, and are easier to revert if something goes wrong.

### Branch naming

```
feat/<short-description>     # new feature
fix/<short-description>      # bug fix
docs/<short-description>     # documentation
refactor/<short-description> # refactor, no behavior change
test/<short-description>     # tests only
```

### Commit messages

Use the conventional commits format:

```
feat(daemon): add per-recipient cooldown gate
fix(renderer): prevent double-approve on tap
docs(usage): add Gmail OAuth pairing steps
```

### Before opening a PR

1. `yarn type-check` — must pass. Zero type errors.
2. `yarn test` — all tests pass. No skipped tests without a comment explaining why.
3. Review the [hard walls](#hard-walls) below. If your change touches any of them, describe in the PR body how each invariant is preserved.
4. If you added a new Prisma table or query, verify it follows the tenant-isolation pattern in [MULTITENANCY.md](MULTITENANCY.md).

### PR description

Include:
- What the change does (1-2 sentences)
- Why it is needed (link to issue if applicable)
- How it was tested
- Any hard walls it touches and how they are preserved
- Screenshots if it changes UI

### Review turnaround

PRs are reviewed within 48 hours on weekdays. Maintainers may request changes. Please respond within 7 days or the PR will be marked stale.

---

## Hard walls

These invariants must never be violated. A PR that breaks any of them is blocked regardless of other merits. They are listed here, and the full technical rationale is in [ARCHITECTURE.md](ARCHITECTURE.md) (cardinal invariants section).

1. **Renderer stays sandboxed.** No direct `fs`, `child_process`, or `net` in renderer code. All privileged ops cross `contextBridge` IPC.

2. **Anti-ban gates live in daemon code.** Never add a rate-limit bypass in a prompt, a config option, or a user-facing toggle. The gates in `apps/desktop/src/daemon/anti-ban/` are the only enforcement path.

3. **Drafts-only for outbound.** There is no "send immediately" path. All sends go through `mesh.send_draft(draft_id)` with a human-approved draft.

4. **Secrets never on disk in plaintext.** Use `ctx.storeSecret()` / macOS Keychain. Never write tokens or passwords to a file.

5. **Voice audio never on disk.** Transcription happens in RAM. Audio buffers are not written to `tmp/` or any file.

6. **Banned platforms stay banned.** The denylist in `plugin-loader.ts` is hardcoded. Do not add a way to bypass it. See [SECURITY.md](SECURITY.md) for the rationale.

7. **Brain split is honored.** WORK and PERSONAL data never mix. If you touch data-access code, verify it is keyed on the correct mode.

8. **Tenant isolation.** Every Prisma query on a tenant-scoped table includes `where: { tenantId: this.tenant.tenantId }`. See [MULTITENANCY.md](MULTITENANCY.md).

9. **cc-modal hardwall.** `mesh.tab_send()` must refuse bare "2\n" or "3\n" keystrokes to a Claude Code session (billing change without consent).

10. **No `--no-verify`, no `--force` push.** Use `--force-with-lease` if you must force-push. Pre-commit hooks run for a reason.

---

## Adding a new comms bridge

To add a new first-party bridge (not a community plugin):

1. Create `apps/desktop/src/daemon/children/my-platform.ts` extending `BaseMeshChild`.
2. Add the child to the daemon supervisor's registry.
3. Add a pair-flow step to the Connections tab wizard.
4. Add anti-ban caps to `apps/desktop/src/daemon/anti-ban/caps.ts` (with research citations for the platform's actual limits).
5. Add tests: at minimum, a unit test for the anti-ban gates and an integration test for the pair flow.
6. Update [docs/USAGE.md](USAGE.md) with the pairing steps.

For a community plugin instead, see [PLUGIN-SDK.md](PLUGIN-SDK.md).

---

## Questions

- GitHub Discussions: [github.com/penrokib/vibeos/discussions](https://github.com/penrokib/vibeos/discussions)
- Security issues: security@vibeos.app (not GitHub issues — see [SECURITY.md](SECURITY.md))
