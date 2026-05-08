// =============================================================================
// BFF — Digest types (mirrors desktop/src/daemon/digest/digest.types.ts)
// =============================================================================

export type DigestKind = 'draft' | 'decision' | 'persona' | 'alert';

export interface DigestItem {
  id: string;
  kind: DigestKind;
  title: string;
  subtitle?: string;
  deepLink?: string;
  /** Unix milliseconds. */
  ts: number;
}

export interface Digest {
  id: string;
  /** Unix milliseconds — iOS decodes via custom DateDecodingStrategy. */
  generatedAt: number;
  mode: 'work' | 'personal';
  needsYou: DigestItem[];
  whatHappened: DigestItem[];
  stuck: DigestItem[];
}
