// =============================================================================
// vibeOS — Search types (cycle 13)
// -----------------------------------------------------------------------------
// Shared types used by both keyword (FTS5) and semantic (LanceDB) engines,
// and the orchestrating SearchService.
//
// Hard walls:
//   - Search runs entirely on-device. Queries and results NEVER leave the
//     device or get sent to BFF.
//   - Embeddings stored encrypted at rest is a v1.1 hardening; v1 is in-memory
//     only.
// =============================================================================

export type SearchScope =
  | 'inbox'
  | 'drafts'
  | 'decisions'
  | 'personas'
  | 'all';

export interface SearchDoc {
  /** Stable unique identifier for this document. */
  id: string;
  /** Which part of the system this doc belongs to. */
  scope: SearchScope;
  /** Optional originating account (e.g. persona handle). */
  account?: string;
  /** Optional short title / subject line. */
  title?: string;
  /** Full text body — the primary searchable field. */
  body: string;
  /** Unix epoch milliseconds. */
  ts: number;
}

export interface SearchHit {
  doc: SearchDoc;
  /** Normalised relevance score (higher = better). */
  score: number;
  /** How this hit was found. */
  matchType: 'keyword' | 'semantic' | 'both';
}

export interface SearchQuery {
  query: string;
  /** Restrict results to a single scope. Omit or use 'all' for global search. */
  scope?: SearchScope;
  /** Maximum number of results to return. Clamped to [1, 200]. Default: 20. */
  limit?: number;
}
