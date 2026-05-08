// =============================================================================
// vibeOS — ComposePipeline (Cycle 18)
// -----------------------------------------------------------------------------
// Phone-side compose handler. Accepts a raw text (or voice-transcribed) message,
// routes it through a CC subprocess via FleetManager with the user's chosen
// persona voice, then POSTs a draft to BFF /agency/drafts.
//
// Hard walls:
//   - NEVER auto-approve the draft. User MUST approve via Cycle 17 SendPipeline.
//   - CC subprocesses run on user's Mac only — BFF NEVER calls CC directly.
//   - Voice audio NEVER hits disk (RAM-only; this layer receives transcribed text).
//   - On CC parse failure: fall back to verbatim rawText. No throw.
//   - Persona registry miss: CC prompt uses default voice. No throw.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { FleetManager } from '../cc-fleet/fleet-manager';
import type { Supervisor } from '../supervisor';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ComposeInput {
  /** Which paired mesh account to send from (e.g. 'personal', 'wap', 'work'). */
  account: string;
  /** Phone number, email, or platform handle of the intended recipient. */
  recipient: string;
  /** Persona id whose voice rules CC should apply (e.g. 'ceo', 'sales-roki'). */
  persona: string;
  /** The user's raw transcribed or typed text. */
  rawText: string;
  /** BCP-47 target language (e.g. 'en', 'ms', 'ar'). Auto-detected when omitted. */
  targetLanguage?: string;
  /** 'work' or 'personal' — affects tone hints in CC prompt. */
  mode: 'work' | 'personal';
}

export interface ComposeResult {
  /** Draft ID returned from BFF /agency/drafts. */
  draftId: string;
  /** CC-polished message text (or verbatim rawText on CC failure). */
  refinedText: string;
  /** CC's explanation; shown in DraftDetailView. 'CC parse failed; preserved input verbatim' on fallback. */
  reasoning: string;
}

export interface ComposeErrorResult {
  error: string;
  detail: string;
}

export type ComposeOutput = ComposeResult | ComposeErrorResult;

// ---------------------------------------------------------------------------
// Internal BFF shape
// ---------------------------------------------------------------------------

interface BffDraftResponse {
  draftId?: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// Heuristic language detection (v1 — simple regex on recipient handle)
// ---------------------------------------------------------------------------

/**
 * Very lightweight heuristic: if the recipient handle contains a Bahasa
 * pattern (common suffixes like @my, @ms, indonesian TLDs, etc.) guess 'ms'.
 * Otherwise default to 'en'. Cycle-25 can replace with a proper LLM-classify.
 */
function detectTargetLanguage(recipient: string): string {
  const lower = recipient.toLowerCase();
  // Malay / Indonesian phone country codes (+60 Malaysia, +62 Indonesia)
  if (/^\+6[02]/.test(lower)) return 'ms';
  // Simple TLD / handle hints
  if (/@my\./.test(lower) || lower.endsWith('.my')) return 'ms';
  return 'en';
}

// ---------------------------------------------------------------------------
// ComposePipeline
// ---------------------------------------------------------------------------

function bffBase(): string {
  return (process.env['ROKIBRAIN_BFF_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
}

function bffToken(): string | null {
  return process.env['ROKIBRAIN_DEV_JWT'] ?? null;
}

export interface ComposePipelineOptions {
  fleet: FleetManager;
  supervisor: Supervisor;
  /** Inject custom fetch for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

/**
 * ComposePipeline — Cycle 18 phone-to-persona compose path.
 *
 * 1. Builds a CC prompt with persona voice rules + recipient context.
 * 2. Submits via FleetManager (subprocess on user's Mac — never BFF-side).
 * 3. Parses output; falls back to verbatim on any parse failure.
 * 4. POSTs draft to BFF /agency/drafts (status = 'pending').
 * 5. Returns {draftId, refinedText, reasoning} — NEVER auto-approved.
 */
export class ComposePipeline {
  private readonly fleet: FleetManager;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ComposePipelineOptions) {
    this.fleet = opts.fleet;
    // supervisor is accepted for DI consistency and future child-lookup use.
    // Not referenced in the current compose path — suppressed with void.
    void opts.supervisor;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ---- public API ----------------------------------------------------------

  async composeDraft(input: ComposeInput): Promise<ComposeOutput> {
    // Guard: account must be plausibly paired (non-empty, safe chars).
    if (!input.account || !/^[a-z0-9_-]{1,32}$/i.test(input.account)) {
      return {
        error: 'INVALID_ACCOUNT',
        detail: `account '${input.account}' is not a valid paired account name`,
      };
    }

    // Determine target language.
    const lang = input.targetLanguage ?? detectTargetLanguage(input.recipient);

    // ── Step 1: build CC prompt ─────────────────────────────────────────────
    const prompt = this.buildPrompt(input, lang);

    // ── Step 2: submit via FleetManager ────────────────────────────────────
    const jobId = randomUUID();
    let ccOutput: string;
    try {
      const result = await this.fleet.submit({
        id: jobId,
        prompt,
        persona: input.persona,
      });
      ccOutput = result.output;
    } catch (err) {
      // CC subprocess unavailable — fall back to verbatim.
      ccOutput = 'CC_ERROR';
      console.warn('[compose-pipeline] FleetManager.submit threw:', err);
    }

    // ── Step 3: parse CC output ─────────────────────────────────────────────
    const { refinedText, reasoning } = this.parseOrFallback(ccOutput, input.rawText);

    // ── Step 4: POST draft to BFF ───────────────────────────────────────────
    const draftId = await this.postDraft(input, refinedText, reasoning);
    if (!draftId) {
      return {
        error: 'BFF_UNREACHABLE',
        detail: 'Failed to post draft to BFF /agency/drafts',
      };
    }

    // ── Step 5: return result (NEVER auto-approved) ─────────────────────────
    return { draftId, refinedText, reasoning };
  }

  // ---- private helpers ------------------------------------------------------

  private buildPrompt(input: ComposeInput, targetLanguage: string): string {
    return (
      `You are the persona '${input.persona}'. ` +
      `Your task: refine the following message into a polished, persona-authentic outbound message. ` +
      `Mode: ${input.mode}. Recipient: ${input.recipient}. Target language: ${targetLanguage}. ` +
      `Voice rules: match persona '${input.persona}' voice — direct, warm, no corporate jargon, ` +
      `anti-spam tone, short sentences, write like a founder who actually knows this recipient. ` +
      `User's raw message: "${input.rawText}". ` +
      `Output ONLY valid JSON (no markdown, no extra keys): ` +
      `{ "text": "<polished message>", "reasoning": "<one sentence why you made your key edit>" }. ` +
      `Never add salutations or sign-offs unless they were in the original. ` +
      `Preserve the intent exactly. Do not add information that wasn't in the original.`
    );
  }

  /**
   * Parse CC stdout. Returns {refinedText, reasoning}.
   * Falls back to verbatim rawText on any failure — never throws.
   */
  private parseOrFallback(
    raw: string,
    rawText: string,
  ): { refinedText: string; reasoning: string } {
    // Graceful degrade: CC not installed or threw.
    if (raw.startsWith('CC_NOT_INSTALLED') || raw.startsWith('CC_ERROR')) {
      return {
        refinedText: rawText,
        reasoning: 'CC parse failed; preserved input verbatim',
      };
    }

    try {
      // Strip optional markdown code fences CC sometimes emits.
      const stripped = raw
        .replace(/^```[a-z]*\n?/m, '')
        .replace(/```$/m, '')
        .trim();
      const parsed = JSON.parse(stripped) as Record<string, unknown>;
      const text = typeof parsed['text'] === 'string' ? parsed['text'].trim() : '';
      const reasoning =
        typeof parsed['reasoning'] === 'string'
          ? parsed['reasoning'].trim()
          : 'No reasoning provided';

      if (!text) {
        return {
          refinedText: rawText,
          reasoning: 'CC parse failed; preserved input verbatim',
        };
      }

      return { refinedText: text, reasoning };
    } catch {
      return {
        refinedText: rawText,
        reasoning: 'CC parse failed; preserved input verbatim',
      };
    }
  }

  /**
   * POST /agency/drafts on BFF.
   * Returns the new draft ID, or null if BFF is unreachable.
   * HARD WALL: never auto-approves — status is always 'pending'.
   */
  private async postDraft(
    input: ComposeInput,
    text: string,
    reasoning: string,
  ): Promise<string | null> {
    const token = bffToken();
    if (!token) return null;

    try {
      const resp = await this.fetchImpl(`${bffBase()}/agency/drafts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          account: input.account,
          recipient: input.recipient,
          text,
          persona: input.persona,
          reasoning,
          mode: input.mode,
          // status is always 'pending' — HARD WALL: never auto-approve.
          status: 'pending',
        }),
      });

      if (!resp.ok) return null;

      const body = (await resp.json()) as BffDraftResponse;
      // BFF may return {draftId:...} or {id:...} depending on convention.
      return body.draftId ?? body.id ?? null;
    } catch {
      return null;
    }
  }
}
