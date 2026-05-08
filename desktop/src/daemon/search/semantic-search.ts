// =============================================================================
// vibeOS — Semantic Search stub (cycle 13)
// -----------------------------------------------------------------------------
// v1 ships a placeholder that returns [] and logs a clear deferral message.
// v1.1 will wire LanceDB + e5-small-v2 embeddings once we validate the
// keyword-only path is solid in production.
//
// The import scaffolding and class interface are complete so v1.1 can drop in
// the real implementation without touching search.service.ts.
//
// Why deferred:
//   - @lancedb/lancedb native Node bindings require a Rust-compiled addon.
//     Apple Silicon wheels exist but the build handshake with electron-rebuild
//     adds non-trivial CI complexity. Blocking cycle 13 on it violates the
//     hardwall "ship keyword side, don't block on semantic".
//   - e5-small-v2 via ONNX Runtime adds a ~50 MB model file; cycle 14 will
//     download it on first-run and verify the sha256.
// =============================================================================

import type { SearchDoc, SearchHit, SearchScope } from './search.types';

// ---------------------------------------------------------------------------
// Types — kept here so v1.1 can fill in the real LanceDB Table shape.
// ---------------------------------------------------------------------------

interface SemanticSearchOptions {
  scope?: SearchScope;
  limit?: number;
}

// ---------------------------------------------------------------------------
// SemanticSearch — placeholder
// ---------------------------------------------------------------------------

export class SemanticSearch {
  private readonly _warnOnce: Set<string> = new Set();

  // -------------------------------------------------------------------------
  // Public API (mirrors KeywordSearch surface intentionally)
  // -------------------------------------------------------------------------

  /**
   * In v1 this is a no-op. v1.1 will embed the doc with e5-small-v2 and
   * upsert the vector into LanceDB.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  index(_doc: SearchDoc): void {
    this._logOnce(
      'semantic:index',
      'semantic search disabled — wire e5-small-v2 in v1.1',
    );
  }

  /**
   * In v1 this is a no-op. v1.1 will batch-embed and upsert all docs.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  indexMany(_docs: SearchDoc[]): void {
    this._logOnce(
      'semantic:indexMany',
      'semantic search disabled — wire e5-small-v2 in v1.1',
    );
  }

  /**
   * Always returns [] in v1. v1.1 will embed the query, run ANN search over
   * LanceDB, and return cosine-similarity ranked hits.
   */
  search(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _query: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: SemanticSearchOptions = {},
  ): SearchHit[] {
    this._logOnce(
      'semantic:search',
      'semantic search disabled — wire e5-small-v2 in v1.1',
    );
    return [];
  }

  /** No-op in v1. */
  clear(): void {
    /* nothing to clear */
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _logOnce(key: string, message: string): void {
    if (!this._warnOnce.has(key)) {
      this._warnOnce.add(key);
      // Use console.warn so it surfaces in electron-log in the main process.
      console.warn(`[SemanticSearch] ${message}`);
    }
  }
}
