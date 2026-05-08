// =============================================================================
// rokibrain.app — CC Fleet types
// -----------------------------------------------------------------------------
// Shared type definitions for the Claude Code fleet manager.
// API keys NEVER appear here — read from env at runtime (never log).
// =============================================================================

/** Per-Anthropic-account descriptor managed by FleetManager. */
export interface CCAccount {
  /** Unique account identifier (e.g. "dewx", "dewx2", "ahn"). */
  id: string;
  /** Max simultaneous CC subprocesses for this account. Default 1. */
  concurrencyMax: number;
  /** Estimated tokens consumed in the last 5h rolling window. */
  tokensUsed5h: number;
  /** Unix ms timestamp when the 5h window started (lastResetAt). */
  lastResetAt: number;
  /** Current account status. */
  status: 'idle' | 'busy' | 'rate-limited';
}

/** A unit of work to be dispatched to a Claude Code subprocess. */
export interface CCJob {
  /** Unique job identifier. */
  id: string;
  /** The prompt / task to pass to `claude`. */
  prompt: string;
  /** Pin to a specific account id (optional; if omitted, round-robin). */
  account?: string;
  /** Persona label for audit log (not sent to subprocess). */
  persona?: string;
}

/** Result returned after a CCJob completes or falls back to graceful degrade. */
export interface CCResult {
  /** Echo of the originating job id. */
  jobId: string;
  /** Account that executed the job. */
  account: string;
  /** Stdout captured from the CC subprocess, or graceful-degrade message. */
  output: string;
  /** Wall-clock milliseconds from submit to completion. */
  durationMs: number;
}
