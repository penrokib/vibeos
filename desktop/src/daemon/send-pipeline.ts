// =============================================================================
// vibeOS — SendPipeline (Cycle 17)
// -----------------------------------------------------------------------------
// Single choke-point for all outbound message sends. EVERY send must go through
// SendPipeline.sendDraft() — never call child.send() directly from any other
// surface.
//
// Architecture §V §5.3 + §VII compliance:
//   - Anti-ban gates are CODE-enforced, never overridable from prompts or UI.
//   - The only documented exception: --unwarmed=true relaxes the warming cap
//     (Architecture §VII.8) but is still bounded by the hard ceiling and is
//     ALWAYS logged.
//   - Refusal envelopes surface to all callers (IPC + MCP) — never silently
//     dropped.
//   - BFF status updates (refuse / sent / error) are best-effort: a BFF outage
//     returns {status:'error',reason:'BFF_UNREACHABLE'} — never throws.
//
// Hard walls (enforced here; DO NOT remove):
//   - withAntiBan() is called unconditionally before child.send().
//   - gate bypass is impossible from IPC/MCP — only --unwarmed flag affects
//     the warming-cap meta sent to BFF, not the gate path itself.
//   - All BFF calls are fire-and-best-effort (catch → log; never rethrow).
// =============================================================================

import type { Supervisor } from './supervisor';
import type { BffCounterClient } from './anti-ban';
import type { AntiBanVerdict } from './types';
import type { WaChild } from './children/wa/wa-child';
import type { BaseMeshChild } from './base-child';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type SendStatus = 'sent' | 'refused' | 'error';

export interface SendResult {
  status: SendStatus;
  messageId?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Draft shape (minimal — from BFF GET /agency/drafts/:id)
// ---------------------------------------------------------------------------

export interface DraftPayload {
  id: string;
  /** Local mesh account name (e.g. 'personal', 'business', 'wap'). */
  account: string;
  /** Recipient JID or platform identifier. */
  recipient: string;
  /** Message text. */
  text: string;
  /** Persona slug that authored the draft. */
  persona?: string;
  /** Attachment metadata (deferred to v1.1 — real image/voice/file not yet sent). */
  attachments?: AttachmentMeta[];
}

export interface AttachmentMeta {
  type: 'image' | 'voice' | 'file';
  /** BFF-resolvable URI — not yet consumed by child.send() in v1. */
  uri: string;
  filename?: string;
}

// ---------------------------------------------------------------------------
// BFF HTTP helper (minimal — re-uses env convention from mesh-mcp-server)
// ---------------------------------------------------------------------------

function bffBase(): string {
  return (process.env['ROKIBRAIN_BFF_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
}

function bffToken(): string | null {
  return process.env['ROKIBRAIN_DEV_JWT'] ?? null;
}

/**
 * Fetch a single draft from BFF.
 * Returns null on 404 (draft genuinely not found).
 * Throws on network errors so the caller can surface BFF_UNREACHABLE.
 */
async function bffGetDraft(
  draftId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DraftPayload | null> {
  const token = bffToken();
  if (!token) return null;
  // Note: we do NOT catch here — network errors propagate to the caller so
  // the caller can return {status:'error', reason:'BFF_UNREACHABLE'}.
  const resp = await fetchImpl(`${bffBase()}/agency/drafts/${encodeURIComponent(draftId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) return null;
  return (await resp.json()) as DraftPayload;
}

async function bffPostStatus(
  draftId: string,
  suffix: 'refuse' | 'sent' | 'error',
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = bffToken();
  if (!token) return; // best-effort — no token, skip
  try {
    await fetchImpl(
      `${bffBase()}/agency/drafts/${encodeURIComponent(draftId)}/${suffix}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    // best-effort — BFF unreachable is tolerated; caller sees error envelope
  }
}

// ---------------------------------------------------------------------------
// Child routing helper
// ---------------------------------------------------------------------------

function findChildByAccount(supervisor: Supervisor, account: string): (WaChild & BaseMeshChild) | null {
  const status = supervisor.status();
  for (const child of status.children) {
    const registered = supervisor.__getChildForTests(child.id);
    if (!registered?.instance) continue;
    const inst = registered.instance as BaseMeshChild & Partial<{ account: string }>;
    if (inst.account === account) {
      return inst as WaChild & BaseMeshChild;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SendPipeline
// ---------------------------------------------------------------------------

export interface SendPipelineOptions {
  supervisor: Supervisor;
  antiBanClient: BffCounterClient;
  /**
   * Inject custom fetch for tests.
   * Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Architecture §VII.8: relaxes the warming-cap meta sent to BFF.
   * ONLY affects the warming-cap softwall — hard ceiling still enforced.
   * ALWAYS logged when true.
   */
  unwarmed?: boolean;
}

/**
 * SendPipeline — the single authoritative send path.
 *
 * HARD WALL: anti-ban gates are never bypassable from prompts or UI.
 * The only exception is the `--unwarmed` flag (Architecture §VII.8).
 */
export class SendPipeline {
  private readonly supervisor: Supervisor;
  private readonly antiBanClient: BffCounterClient;
  private readonly fetchImpl: typeof fetch;
  private readonly unwarmed: boolean;

  constructor(opts: SendPipelineOptions) {
    this.supervisor = opts.supervisor;
    this.antiBanClient = opts.antiBanClient;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.unwarmed = opts.unwarmed ?? false;

    if (this.unwarmed) {
      console.warn(
        '[send-pipeline] --unwarmed=true: warming cap relaxed (Architecture §VII.8). ' +
          'Hard ceiling still enforced. This action is logged.',
      );
    }
  }

  /**
   * Send a draft end-to-end.
   *
   * Step 1 — fetch draft from BFF.
   * Step 2 — evaluate anti-ban gate suite.
   * Step 3 — if refused → POST /refuse → return {status:'refused'}.
   * Step 4 — resolve child via Supervisor.
   * Step 5 — call child.send().
   * Step 6 — POST /sent → return {status:'sent'}.
   * Step 7 — on send error → POST /error → return {status:'error'}.
   */
  async sendDraft(draftId: string): Promise<SendResult> {
    // ── Step 1: fetch draft ──────────────────────────────────────────────────
    let draft: DraftPayload | null;
    try {
      draft = await bffGetDraft(draftId, this.fetchImpl);
    } catch {
      await bffPostStatus(draftId, 'error', { reason: 'BFF_UNREACHABLE' }, this.fetchImpl);
      return { status: 'error', reason: 'BFF_UNREACHABLE' };
    }

    if (!draft) {
      return { status: 'error', reason: 'DRAFT_NOT_FOUND' };
    }

    // ── Step 2: anti-ban gate ────────────────────────────────────────────────
    // Hard wall: antiBanClient.increment() is always called. No bypass from
    // prompts or UI. The per-instance antiBanClient allows test injection.
    const gateMeta: Record<string, unknown> = {
      recipientHash: hashRecipient(draft.recipient),
      bodyLen: draft.text.length,
      persona: draft.persona ?? 'unknown',
    };
    if (this.unwarmed) {
      // §VII.8: signal to BFF that warming cap should be relaxed for this send.
      gateMeta['unwarmed'] = true;
    }

    let gateVerdict: AntiBanVerdict;
    try {
      gateVerdict = await this.antiBanClient.increment({
        childId: `pipeline:${draft.account}`,
        action: 'draft_send',
        accountId: draft.account,
        meta: gateMeta,
      });
    } catch {
      // Failing closed: gate client threw → refuse
      const reason = 'anti_ban_gate_error';
      await bffPostStatus(draftId, 'refuse', { reason }, this.fetchImpl);
      return { status: 'refused', reason };
    }

    if (!gateVerdict.allowed) {
      const reason = gateVerdict.reasons?.join(', ') ?? 'rate_limited';
      await bffPostStatus(draftId, 'refuse', { reason }, this.fetchImpl);
      return { status: 'refused', reason };
    }

    // ── Step 4: resolve child ────────────────────────────────────────────────
    const child = findChildByAccount(this.supervisor, draft.account);
    if (!child) {
      const reason = 'account_not_paired';
      await bffPostStatus(draftId, 'error', { reason }, this.fetchImpl);
      return { status: 'error', reason };
    }

    // ── Step 5: send via child ───────────────────────────────────────────────
    // child.send() wraps in withAntiBan internally (WaChild hardwall) — the
    // outer gate above gives the BFF a chance to record intent; child's inner
    // gate enforces the actual platform-level counters.
    //
    // NOTE: real attachments (image/voice/file) are NOT forwarded in v1.
    // Deferred to v1.1 — see SendPipelineOptions.unwarmed note above.
    try {
      await child.send(draft.recipient, draft.text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await bffPostStatus(draftId, 'error', { reason }, this.fetchImpl);
      return { status: 'error', reason };
    }

    // ── Step 6: mark sent ────────────────────────────────────────────────────
    const messageId = `msg_${Date.now()}_${draftId.slice(0, 8)}`;
    await bffPostStatus(draftId, 'sent', { messageId }, this.fetchImpl);
    return { status: 'sent', messageId };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cheap one-way hash so logs never expose cleartext phone numbers / JIDs.
 * Same algorithm as WaChild.hashRecipient for consistency.
 */
function hashRecipient(jid: string): string {
  let h = 5381;
  for (let i = 0; i < jid.length; i++) {
    h = ((h << 5) + h) ^ jid.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16);
}
