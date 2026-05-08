// =============================================================================
// rokibrain.app — Digest types
// -----------------------------------------------------------------------------
// Mirrors the iOS Digest model (mobile/Rokibrain/Models/Digest.swift).
// JSON keys use snake_case to match the Swift CodingKeys.
// =============================================================================

export type DigestKind = 'draft' | 'decision' | 'persona' | 'alert';

export interface DigestItem {
  id: string;
  kind: DigestKind;
  title: string;
  subtitle?: string;
  /** vibeos:// deep-link URI consumed by the iOS Today screen. */
  deepLink?: string;
  /** Unix milliseconds. */
  ts: number;
}

export interface Digest {
  id: string;
  /** Unix milliseconds (matches iOS `generatedAt: Date` decoded from epoch). */
  generatedAt: number;
  mode: 'work' | 'personal';
  /** Items requiring an explicit user action (approve, reply, decide). */
  needsYou: DigestItem[];
  /** Completed / background events in the last 6 hours. */
  whatHappened: DigestItem[];
  /** Personas or queues that appear stalled. */
  stuck: DigestItem[];
}

// ---------------------------------------------------------------------------
// Signal shape — v1 uses synthetic placeholders; cycle 17 injects real sources
// ---------------------------------------------------------------------------

export interface RawSignal {
  /** Number of drafts currently queued. */
  draftCount: number;
  /** Number of pending decisions. */
  decisionCount: number;
  /** Personas flagged as idle > 4 h. */
  idlePersonas: string[];
  /** Recent alerts (titles only — NO PII per cycle-17 hard wall). */
  recentAlertTitles: string[];
}

/** Optional override for signal sourcing (DI hook for cycle 17 + tests). */
export type SignalProvider = () => RawSignal | Promise<RawSignal>;
