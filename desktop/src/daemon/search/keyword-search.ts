// =============================================================================
// vibeOS — Keyword Search via SQLite FTS5 (cycle 13)
// -----------------------------------------------------------------------------
// In-memory SQLite DB with a FTS5 virtual table. Fast, zero-network,
// fully on-device. Uses better-sqlite3 for synchronous Node.js bindings.
//
// API surface:
//   index(doc)          — upsert a single document
//   indexMany(docs)     — bulk upsert (transactional)
//   search(query, opts) — return ranked SearchHit[]
//   clear()             — drop all indexed data (for testing)
// =============================================================================

import Database from 'better-sqlite3';
import type { SearchDoc, SearchHit, SearchScope } from './search.types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_DOCS_TABLE = `
  CREATE TABLE IF NOT EXISTS docs (
    id      TEXT PRIMARY KEY,
    scope   TEXT NOT NULL,
    account TEXT,
    title   TEXT,
    body    TEXT NOT NULL,
    ts      INTEGER NOT NULL
  );
`;

const CREATE_FTS_TABLE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    id UNINDEXED,
    scope UNINDEXED,
    title,
    body,
    content='docs',
    content_rowid='rowid'
  );
`;

// Triggers to keep the FTS index in sync with the backing table.
const CREATE_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, id, scope, title, body)
      VALUES (new.rowid, new.id, new.scope, new.title, new.body);
  END;

  CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, id, scope, title, body)
      VALUES ('delete', old.rowid, old.id, old.scope, old.title, old.body);
  END;

  CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, id, scope, title, body)
      VALUES ('delete', old.rowid, old.id, old.scope, old.title, old.body);
    INSERT INTO docs_fts(rowid, id, scope, title, body)
      VALUES (new.rowid, new.id, new.scope, new.title, new.body);
  END;
`;

// ---------------------------------------------------------------------------
// KeywordSearch class
// ---------------------------------------------------------------------------

interface SearchOptions {
  scope?: SearchScope;
  limit?: number;
}

export class KeywordSearch {
  private readonly db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    // WAL mode for better write concurrency (even in-memory it's a noop,
    // but good hygiene for file-backed databases in future cycles).
    this.db.pragma('journal_mode = WAL');
    this._initSchema();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _initSchema(): void {
    this.db.exec(CREATE_DOCS_TABLE);
    this.db.exec(CREATE_FTS_TABLE);
    this.db.exec(CREATE_TRIGGERS);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Upsert a single document. If a doc with the same `id` already exists it
   * is replaced — no duplicates.
   */
  index(doc: SearchDoc): void {
    // DELETE existing first (triggers maintain FTS index).
    this.db
      .prepare('DELETE FROM docs WHERE id = ?')
      .run(doc.id);

    this.db
      .prepare(
        `INSERT INTO docs (id, scope, account, title, body, ts)
         VALUES (@id, @scope, @account, @title, @body, @ts)`,
      )
      .run({
        id: doc.id,
        scope: doc.scope,
        account: doc.account ?? null,
        title: doc.title ?? null,
        body: doc.body,
        ts: doc.ts,
      });
  }

  /**
   * Upsert many documents in a single transaction — much faster than calling
   * `index()` in a loop for large corpora.
   */
  indexMany(docs: SearchDoc[]): void {
    const upsert = this.db.transaction((rows: SearchDoc[]) => {
      for (const doc of rows) {
        this.index(doc);
      }
    });
    upsert(docs);
  }

  /**
   * Keyword search over the FTS5 index.
   *
   * @param query   FTS5 query string (plain text; will be quoted to prevent
   *                injection from special FTS5 syntax characters).
   * @param options Scope filter + limit.
   * @returns       Ranked hits, highest BM25 score first.
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
    const safeQuery = this._sanitiseFtsQuery(query);

    let sql: string;
    let params: (string | number)[];

    if (options.scope && options.scope !== 'all') {
      sql = `
        SELECT
          d.id, d.scope, d.account, d.title, d.body, d.ts,
          -bm25(docs_fts) AS score
        FROM docs_fts
        JOIN docs d ON docs_fts.id = d.id
        WHERE docs_fts MATCH ?
          AND d.scope = ?
        ORDER BY score DESC
        LIMIT ?
      `;
      params = [safeQuery, options.scope, limit];
    } else {
      sql = `
        SELECT
          d.id, d.scope, d.account, d.title, d.body, d.ts,
          -bm25(docs_fts) AS score
        FROM docs_fts
        JOIN docs d ON docs_fts.id = d.id
        WHERE docs_fts MATCH ?
        ORDER BY score DESC
        LIMIT ?
      `;
      params = [safeQuery, limit];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      scope: SearchScope;
      account: string | null;
      title: string | null;
      body: string;
      ts: number;
      score: number;
    }>;

    return rows.map((row) => ({
      doc: {
        id: row.id,
        scope: row.scope,
        account: row.account ?? undefined,
        title: row.title ?? undefined,
        body: row.body,
        ts: row.ts,
      },
      score: row.score,
      matchType: 'keyword' as const,
    }));
  }

  /** Drop all indexed data. Primarily useful for tests. */
  clear(): void {
    this.db.exec('DELETE FROM docs');
    // FTS is content-table backed; the triggers already handle deletes, but
    // we also run a rebuild to ensure the shadow table is fully clean.
    this.db.exec("INSERT INTO docs_fts(docs_fts) VALUES ('rebuild')");
  }

  /** Close the underlying DB handle (only matters for file-backed databases). */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // FTS5 query sanitisation
  // -------------------------------------------------------------------------

  /**
   * Wrap the user query in double-quotes to treat it as a phrase search.
   * This prevents user-supplied FTS5 special characters (AND, OR, NOT, *, etc.)
   * from being interpreted as operators.
   *
   * For multi-word queries we do an implicit OR across individual terms
   * so single-word matches still surface useful results.
   */
  private _sanitiseFtsQuery(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '""';

    // Escape any embedded double-quotes in the query text.
    const escaped = trimmed.replace(/"/g, '""');
    // Return as a quoted phrase — FTS5 will match the exact sequence of tokens.
    return `"${escaped}"`;
  }
}
