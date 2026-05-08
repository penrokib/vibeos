// =============================================================================
// rokibrain.app — anti-ban hook (M02)
// -----------------------------------------------------------------------------
// Every outbound platform action MUST be wrapped in `withAntiBan(…)`. The
// hook posts a counter increment to the BFF (`POST /mesh/counters` — the
// shape ships with M03's mesh module; the increment-side endpoint will be
// added by M04 owners. Until then, wrapping is still mandatory and refusals
// from the BFF surface as 429 — the wrapper rejects with a typed verdict).
//
// Hardwalls (per design §3 + feedback-wa-mcp-robust.md):
//   - ALL anti-ban math is enforced server-side; this client wrapper only
//     coordinates + records the verdict. No LLM input here.
//   - On 429 (or any non-2xx), the wrapper REFUSES the action and returns
//     `{ allowed: false, … }`. Caller MUST honour `allowed=false`.
//
// Plus: feedback-cc-modal-dismiss.md regression. `assertSafeTmuxKeystroke`
// rejects bare `2` or `3` followed by Enter — these change Claude Code billing.
// M06 (terminal-mirror) calls this before every send-keys it forwards.
// =============================================================================

import type { AntiBanVerdict } from './types';

export interface BffCounterClient {
  /**
   * Increment a counter for `accountId/childId/action` and ask BFF for a
   * verdict. Implementations resolve to {allowed:false} on any non-2xx.
   */
  increment(input: {
    childId: string;
    action: string;
    accountId?: string;
    /** Optional metadata — body length, recipient hash, similarity score, etc. */
    meta?: Record<string, unknown>;
  }): Promise<AntiBanVerdict>;
}

export interface WithAntiBanArgs {
  childId: string;
  action: string;
  accountId?: string;
  meta?: Record<string, unknown>;
}

let activeClient: BffCounterClient | null = null;

/** Install the BFF client; called once by daemon bootstrap. */
export function setBffCounterClient(client: BffCounterClient | null): void {
  activeClient = client;
}

export function getBffCounterClient(): BffCounterClient | null {
  return activeClient;
}

/**
 * Wrap an outbound platform action. Refuses BEFORE invoking `fn` if the
 * BFF rejects. Returns the same shape regardless of which gate refused.
 */
export async function withAntiBan<T>(
  args: WithAntiBanArgs,
  fn: () => Promise<T>,
): Promise<{ allowed: true; value: T } | { allowed: false; verdict: AntiBanVerdict }> {
  if (!activeClient) {
    // Failing closed: no client wired = refuse. Forces the daemon bootstrap
    // to install a real one before any child runs.
    return {
      allowed: false,
      verdict: { allowed: false, reasons: ['no_anti_ban_client_installed'] },
    };
  }
  const verdict = await activeClient.increment({
    childId: args.childId,
    action: args.action,
    ...(args.accountId !== undefined ? { accountId: args.accountId } : {}),
    ...(args.meta !== undefined ? { meta: args.meta } : {}),
  });
  if (!verdict.allowed) {
    return { allowed: false, verdict };
  }
  const value = await fn();
  return { allowed: true, value };
}

// =============================================================================
// HTTP-backed BFF client. Used by daemon in production. Tests inject a fake
// implementation of `BffCounterClient` directly.
// =============================================================================

export interface HttpBffOptions {
  baseUrl: string;
  /** Bearer token for the BFF. */
  token: string;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export class HttpBffCounterClient implements BffCounterClient {
  constructor(private readonly opts: HttpBffOptions) {}

  async increment(input: {
    childId: string;
    action: string;
    accountId?: string;
    meta?: Record<string, unknown>;
  }): Promise<AntiBanVerdict> {
    const f = this.opts.fetchImpl ?? fetch;
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/mesh/counters`;
    let resp: Response;
    try {
      resp = await f(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify(input),
      });
    } catch (err) {
      return { allowed: false, reasons: [`bff_unreachable:${String(err)}`] };
    }
    if (resp.status === 429) {
      let body: unknown = null;
      try {
        body = await resp.json();
      } catch {
        /* swallow */
      }
      const reasons = isReasonsBody(body) ? body.reasons : ['rate_limited'];
      const next = isReasonsBody(body) ? body.nextWindowAt : undefined;
      const counters = isReasonsBody(body) ? body.counters : undefined;
      return {
        allowed: false,
        reasons,
        ...(next !== undefined ? { nextWindowAt: next } : {}),
        ...(counters !== undefined ? { counters } : {}),
      };
    }
    if (!resp.ok) {
      return { allowed: false, reasons: [`bff_${resp.status}`] };
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return { allowed: false, reasons: ['bff_invalid_json'] };
    }
    if (isVerdictBody(body)) {
      return body;
    }
    // Tolerant: if BFF responded 200 with a counters-only body, treat as allow.
    return { allowed: true, ...(isCountersBody(body) ? { counters: body.counters } : {}) };
  }
}

function isReasonsBody(
  v: unknown,
): v is { reasons?: string[]; nextWindowAt?: string; counters?: Record<string, number> } {
  return typeof v === 'object' && v !== null;
}

function isVerdictBody(v: unknown): v is AntiBanVerdict {
  return typeof v === 'object' && v !== null && 'allowed' in v;
}

function isCountersBody(v: unknown): v is { counters: Record<string, number> } {
  return (
    typeof v === 'object' &&
    v !== null &&
    'counters' in v &&
    typeof (v as { counters: unknown }).counters === 'object'
  );
}

// =============================================================================
// CC-modal hardwall (feedback-cc-modal-dismiss.md)
// -----------------------------------------------------------------------------
// Claude Code limit-prompt accepts bare numeric keys to choose plan / billing.
// Sending `2` (extra usage) or `3` (Team plan) followed by Enter is a billing-
// changing action and is FORBIDDEN. M06 routes every send-keys it forwards
// through `assertSafeTmuxKeystroke`. Throws on violation; caller logs +
// surfaces a refusal.
// =============================================================================

export class UnsafeKeystrokeError extends Error {
  constructor(reason: string) {
    super(`unsafe keystroke refused: ${reason}`);
    this.name = 'UnsafeKeystrokeError';
  }
}

/**
 * Check a sequence of keys destined for a tmux pane. The forbidden patterns
 * are exact bare `2` or `3` followed by Enter — as documented in
 * feedback-cc-modal-dismiss.md.
 *
 * The function accepts either:
 *   - a single string ("2\r" or "2\n" or "2") — common in tmux send-keys -l
 *   - an array of tmux key tokens (["2", "Enter"]) — common in tmux send-keys
 *
 * Keystrokes that include a `2` or `3` as part of a longer token (e.g. "23",
 * "abc2def") are allowed; only bare-key + Enter is the modal contract.
 */
export function assertSafeTmuxKeystroke(input: string | readonly string[]): void {
  const tokens = normaliseTokens(input);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '2' || t === '3') {
      const next = tokens[i + 1];
      if (next === 'Enter' || next === '\r' || next === '\n' || next === '\r\n') {
        throw new UnsafeKeystrokeError(
          `bare '${t}' followed by Enter is forbidden — feedback-cc-modal-dismiss.md`,
        );
      }
    }
  }
}

/** Same as assertSafeTmuxKeystroke but returns boolean instead of throwing. */
export function isSafeTmuxKeystroke(input: string | readonly string[]): boolean {
  try {
    assertSafeTmuxKeystroke(input);
    return true;
  } catch {
    return false;
  }
}

function normaliseTokens(input: string | readonly string[]): string[] {
  if (Array.isArray(input)) return [...input];
  // String form: split on Enter-likes but keep them as separate tokens.
  // We split keeping delimiters so "2\r" → ["2", "\r"].
  const s = input as string;
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\r' || ch === '\n') {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      // collapse \r\n into one delimiter
      if (ch === '\r' && s[i + 1] === '\n') {
        out.push('\r\n');
        i += 1;
      } else {
        out.push(ch);
      }
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}
