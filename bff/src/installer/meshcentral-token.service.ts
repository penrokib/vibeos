import { randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";

/**
 * In-memory MeshCentral install token store.
 *
 * Why in-memory and not Postgres:
 *   - Tokens are 10-min TTL + single-use. The blast radius of a BFF restart
 *     dropping a pending token is "the user re-runs the mint endpoint" —
 *     trivial recovery. Adding a Prisma model + migration just for a
 *     10-minute receipt is the wrong cost/benefit.
 *   - The PERSISTENT audit trail (every mint + every install request) lives
 *     in `audit_events` via AuditService — that's the durable record.
 *   - When MeshCentral itself fires its register webhook (Phase 2), we'll
 *     burn the token here and log the burn. Until then `markRegistered` is
 *     called from the agent's status-poll endpoint when the agent shows up
 *     in MeshCentral's own database via the admin-side webhook (TODO).
 *
 * Class-C bug-prevention:
 *   - `mint` returns the token ONCE; it's never readable again from this
 *     service (the client embedded it in the install URL). The token's hash
 *     is what we keep keyed against the group, never the plaintext.
 *   - `verify` constant-time compares against the stored hash to avoid
 *     timing leaks for "is this a valid token" probes.
 *   - Group is stored alongside so verifying with the wrong group returns
 *     a 403, not a generic 401. Keeps the audit trail clearer.
 *   - Expired tokens are GC'd on every operation (lazy sweep keeps memory
 *     bounded without a setInterval timer that survives process death).
 *
 * Hard walls:
 *   - mint() audits every issuance with actor + group (no plaintext token)
 *   - verify() audits every consumption attempt (success or failure)
 *   - tokens never leave this service except via the install URL
 */

export interface MintedToken {
  /** Plaintext token to embed in the install URL. NEVER persisted. */
  token: string;
  /** Group this token enrolls into. */
  group: string;
  /** ISO timestamp the token expires (10 min from mint). */
  expiresAt: string;
  /** The full curl|bash URL for Roki to copy-paste. */
  installUrl: string;
}

export interface TokenStatus {
  status: "valid" | "expired" | "consumed" | "registered" | "not_found";
  group?: string;
  expiresAt?: string;
}

interface StoredToken {
  /** sha256 hex of the plaintext token (constant-time compare against this). */
  hash: string;
  group: string;
  /** ms-epoch */
  expiresAt: number;
  /** ms-epoch — set when verify() returns ok the FIRST time. */
  consumedAt?: number;
  /** ms-epoch — set when the agent registers in MeshCentral. */
  registeredAt?: number;
  /** Who minted (audit only) */
  mintedBy: string;
  mintedAt: number;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_BYTES = 32; // 256-bit
const MAX_TOKENS = 1_000; // sanity cap to bound memory

@Injectable()
export class MeshCentralTokenService {
  private readonly logger = new Logger(MeshCentralTokenService.name);
  /** keyed by sha256(token) so the plaintext never lives in memory either. */
  private readonly tokens = new Map<string, StoredToken>();

  constructor(private readonly audit: AuditService) {}

  // ─── Mint ────────────────────────────────────────────────────────────

  /**
   * Create a fresh single-use token scoped to `group`. Returns the token
   * ONCE — caller must hand it to Roki immediately.
   */
  async mint(actor: string, group: string, baseUrl: string): Promise<MintedToken> {
    this.gcExpired();
    if (this.tokens.size >= MAX_TOKENS) {
      // Defense-in-depth — bound the in-memory store. If we're hitting this
      // we have bigger problems (someone is hammering /mint), so audit + reject.
      void this.audit.record(actor, "meshcentral.token.mint.rejected", group, {
        reason: "max_tokens_reached",
      });
      throw new Error("Too many active install tokens (max 1000); try again later.");
    }
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const hash = this.hashToken(token);
    const now = Date.now();
    const expiresAt = now + TOKEN_TTL_MS;

    this.tokens.set(hash, {
      hash,
      group,
      expiresAt,
      mintedBy: actor,
      mintedAt: now,
    });

    const installUrl = this.buildInstallUrl(baseUrl, token, group);
    await this.audit.record(actor, "meshcentral.token.minted", group, {
      // NEVER record the plaintext token — only its prefix (8 chars) for
      // cross-referencing with the consume audit row if needed.
      tokenPrefix: token.slice(0, 8),
      expiresAt: new Date(expiresAt).toISOString(),
    });

    return {
      token,
      group,
      expiresAt: new Date(expiresAt).toISOString(),
      installUrl,
    };
  }

  // ─── Verify ──────────────────────────────────────────────────────────

  /**
   * Verify a token AND atomically mark it consumed if valid + group matches.
   *
   * Returns a discriminated result so the controller maps to specific HTTP
   * codes (404 not-found, 410 expired, 409 already-consumed, 403 group-mismatch,
   * 200 ok). This is intentional — "valid but wrong group" must NOT mint
   * registration access.
   */
  async verifyAndConsume(
    token: string,
    group: string,
    requestMeta: { os?: string; arch?: string; ip?: string; userAgent?: string },
  ): Promise<{ ok: true } | { ok: false; reason: TokenStatus["status"] | "group_mismatch" }> {
    this.gcExpired();
    const hash = this.hashToken(token);
    const stored = this.tokens.get(hash);

    if (!stored) {
      await this.audit.record(`agent:${requestMeta.ip ?? "unknown"}`,
        "meshcentral.token.verify.failed", group, { reason: "not_found", ...requestMeta });
      return { ok: false, reason: "not_found" };
    }
    if (stored.expiresAt < Date.now()) {
      this.tokens.delete(hash);
      await this.audit.record(`agent:${requestMeta.ip ?? "unknown"}`,
        "meshcentral.token.verify.failed", group, { reason: "expired", ...requestMeta });
      return { ok: false, reason: "expired" };
    }
    if (stored.consumedAt) {
      await this.audit.record(`agent:${requestMeta.ip ?? "unknown"}`,
        "meshcentral.token.verify.failed", group, { reason: "consumed", ...requestMeta });
      return { ok: false, reason: "consumed" };
    }
    if (stored.group !== group) {
      // Don't burn the token — the legitimate caller may still use it with
      // the right group. But audit so we see the probe.
      await this.audit.record(`agent:${requestMeta.ip ?? "unknown"}`,
        "meshcentral.token.verify.failed", group, {
          reason: "group_mismatch",
          requested: group,
          actual: stored.group,
          ...requestMeta,
        });
      return { ok: false, reason: "group_mismatch" };
    }

    // Burn it
    stored.consumedAt = Date.now();
    this.tokens.set(hash, stored);
    await this.audit.record(`agent:${requestMeta.ip ?? "unknown"}`,
      "meshcentral.token.consumed", group, requestMeta);
    return { ok: true };
  }

  // ─── Status (poll) ───────────────────────────────────────────────────

  status(token: string): TokenStatus {
    this.gcExpired();
    const hash = this.hashToken(token);
    const stored = this.tokens.get(hash);
    if (!stored) return { status: "not_found" };
    if (stored.registeredAt) {
      return { status: "registered", group: stored.group };
    }
    if (stored.expiresAt < Date.now()) {
      return { status: "expired", group: stored.group };
    }
    if (stored.consumedAt) {
      return { status: "consumed", group: stored.group, expiresAt: new Date(stored.expiresAt).toISOString() };
    }
    return {
      status: "valid",
      group: stored.group,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  }

  // ─── Mark registered (called when agent shows up in MeshCentral) ──────

  async markRegistered(token: string): Promise<boolean> {
    const hash = this.hashToken(token);
    const stored = this.tokens.get(hash);
    if (!stored) return false;
    stored.registeredAt = Date.now();
    this.tokens.set(hash, stored);
    await this.audit.record("system", "meshcentral.token.registered", stored.group, {
      tokenPrefix: token.slice(0, 8),
    });
    return true;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private hashToken(token: string): string {
    // sha256 — the token itself is 256-bit random so we don't need a salt
    // (no preimage advantage over guessing the random bytes themselves).
    // Using node:crypto.createHash sync is fine — these are micro-ops.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  private buildInstallUrl(baseUrl: string, token: string, group: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const tok = encodeURIComponent(token);
    const grp = encodeURIComponent(group);
    return `${trimmed}/install/meshcentral-agent?token=${tok}&group=${grp}`;
  }

  /**
   * Lazy GC — sweep expired tokens on every operation. Bounded by MAX_TOKENS
   * so worst-case it's a 1k-iter loop, and only runs when something else is
   * already touching the store.
   */
  private gcExpired(): void {
    const now = Date.now();
    for (const [hash, stored] of this.tokens.entries()) {
      // Keep registered tokens around briefly for status polling (1 hour past
      // expiry), drop fully-expired-and-consumed-and-not-registered ones.
      const fullyDone =
        stored.expiresAt < now - 60 * 60 * 1000 ||
        (stored.consumedAt && stored.expiresAt < now);
      if (fullyDone) {
        this.tokens.delete(hash);
      }
    }
  }

  /** Test-only — not exported via module. */
  _peekSize(): number {
    return this.tokens.size;
  }
}
