// =============================================================================
// vibeOS — SearchService orchestrator (cycle 13)
// -----------------------------------------------------------------------------
// Runs both KeywordSearch and SemanticSearch in parallel, merges results,
// deduplicates by doc ID, bumps score + sets matchType:'both' when both
// engines return the same doc, then returns top-N by score.
//
// Hard walls:
//   - All search is on-device. NEVER sends query/results to BFF.
//   - Embeddings stored encrypted at rest is a v1.1 hardening; v1 is in-memory.
// =============================================================================

import { KeywordSearch } from './keyword-search';
import { SemanticSearch } from './semantic-search';
import type { SearchDoc, SearchHit, SearchQuery } from './search.types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;

// ---------------------------------------------------------------------------
// SearchService
// ---------------------------------------------------------------------------

export class SearchService {
  private readonly keyword: KeywordSearch;
  private readonly semantic: SemanticSearch;

  constructor() {
    this.keyword = new KeywordSearch(':memory:');
    this.semantic = new SemanticSearch();
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  /**
   * Upsert a single document into both engines. Reindexing the same doc (same
   * `id`) does NOT create duplicates — both engines handle upsert semantics.
   */
  index(doc: SearchDoc): void {
    this.keyword.index(doc);
    this.semantic.index(doc);
  }

  /**
   * Bulk upsert — much more efficient than calling `index()` in a loop.
   */
  indexMany(docs: SearchDoc[]): void {
    this.keyword.indexMany(docs);
    this.semantic.indexMany(docs);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Run hybrid search: keyword + semantic (semantic returns [] in v1).
   *
   * Merge strategy:
   *   1. Collect all hits from both engines.
   *   2. If a doc ID appears in both, take the maximum score and set
   *      matchType:'both'.
   *   3. Sort by score descending.
   *   4. Return top-N (limit clamped to [1, 200]).
   */
  search(searchQuery: SearchQuery): SearchHit[] {
    const limit = Math.max(
      MIN_LIMIT,
      Math.min(searchQuery.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    );

    const opts = {
      scope: searchQuery.scope,
      // Ask each engine for more candidates so the merge has enough to pick
      // from — we'll trim to `limit` at the end.
      limit: Math.min(limit * 3, MAX_LIMIT),
    };

    const kwHits = this.keyword.search(searchQuery.query, opts);
    const semHits = this.semantic.search(searchQuery.query, opts);

    return this._merge(kwHits, semHits, limit);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Drop all indexed data from both engines. Primarily useful for tests. */
  clear(): void {
    this.keyword.clear();
    this.semantic.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Deduplicate and merge hits from both engines.
   *
   * - If a doc appears only in keyword hits → matchType:'keyword'.
   * - If a doc appears only in semantic hits → matchType:'semantic'.
   * - If a doc appears in both → matchType:'both', score = max(kw, sem).
   */
  private _merge(
    kwHits: SearchHit[],
    semHits: SearchHit[],
    limit: number,
  ): SearchHit[] {
    const map = new Map<string, SearchHit>();

    for (const hit of kwHits) {
      map.set(hit.doc.id, { ...hit, matchType: 'keyword' });
    }

    for (const hit of semHits) {
      const existing = map.get(hit.doc.id);
      if (existing) {
        // Doc found by both engines.
        map.set(hit.doc.id, {
          doc: existing.doc,
          score: Math.max(existing.score, hit.score),
          matchType: 'both',
        });
      } else {
        map.set(hit.doc.id, { ...hit, matchType: 'semantic' });
      }
    }

    return [...map.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
