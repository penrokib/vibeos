// =============================================================================
// vibeOS — SearchService tests (cycle 13)
// =============================================================================

import { SearchService } from '../search.service';
import { KeywordSearch } from '../keyword-search';
import { SemanticSearch } from '../semantic-search';
import type { SearchDoc, SearchScope } from '../search.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPES: SearchScope[] = ['inbox', 'drafts', 'decisions', 'personas'];

function makeDocs(count: number): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (let i = 0; i < count; i++) {
    const scope = SCOPES[i % SCOPES.length];
    docs.push({
      id: `doc-${i}`,
      scope,
      account: `persona-${i % 4}`,
      title: `Title for document ${i}`,
      body: `This is the body of document number ${i}. It contains some unique content: uniquetoken-${i}.`,
      ts: Date.now() - i * 1000,
    });
  }
  return docs;
}

// ---------------------------------------------------------------------------
// SearchService (hybrid)
// ---------------------------------------------------------------------------

describe('SearchService', () => {
  let svc: SearchService;

  beforeEach(() => {
    svc = new SearchService();
  });

  it('indexes and searches 100 synthetic docs', () => {
    const docs = makeDocs(100);
    svc.indexMany(docs);

    const results = svc.search({ query: 'body of document', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('keyword query for a unique token returns exactly 1 hit', () => {
    const docs = makeDocs(100);
    svc.indexMany(docs);

    const results = svc.search({ query: 'uniquetoken-42', limit: 20 });
    expect(results.length).toBe(1);
    expect(results[0].doc.id).toBe('doc-42');
    expect(results[0].matchType).toBe('keyword');
  });

  it('keyword query completes in under 50 ms for 100 docs', () => {
    const docs = makeDocs(100);
    svc.indexMany(docs);

    const start = performance.now();
    svc.search({ query: 'uniquetoken-7', limit: 20 });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it('natural-language query returns ranked results', () => {
    const docs = makeDocs(100);
    // Add a doc whose body is clearly about "invoice payment"
    docs.push({
      id: 'special-invoice',
      scope: 'inbox',
      body: 'invoice payment received confirmation EUR 500',
      ts: Date.now(),
    });
    svc.indexMany(docs);

    const results = svc.search({ query: 'invoice payment', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    // The specialised doc should be in the results
    const ids = results.map((r) => r.doc.id);
    expect(ids).toContain('special-invoice');
  });

  it('scope filter restricts results to the given scope', () => {
    const docs = makeDocs(100);
    svc.indexMany(docs);

    const results = svc.search({
      query: 'document',
      scope: 'inbox',
      limit: 50,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const hit of results) {
      expect(hit.doc.scope).toBe('inbox');
    }
  });

  it("scope:'all' returns docs from all scopes", () => {
    const docs = makeDocs(100);
    svc.indexMany(docs);

    const results = svc.search({ query: 'document', scope: 'all', limit: 100 });
    const scopes = new Set(results.map((r) => r.doc.scope));
    expect(scopes.size).toBeGreaterThan(1);
  });

  it('limit clamping: limit 0 is clamped to 1', () => {
    const docs = makeDocs(20);
    svc.indexMany(docs);

    const results = svc.search({ query: 'document', limit: 0 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('limit clamping: limit 9999 is clamped to 200', () => {
    const docs = makeDocs(100);
    svc.indexMany(docs);

    const results = svc.search({ query: 'document', limit: 9999 });
    expect(results.length).toBeLessThanOrEqual(200);
  });

  it('reindexing the same doc does not create duplicates', () => {
    const doc: SearchDoc = {
      id: 'dup-test',
      scope: 'inbox',
      body: 'original body text',
      ts: Date.now(),
    };
    svc.index(doc);
    svc.index(doc); // second index of same id
    svc.index(doc); // third index of same id

    const results = svc.search({ query: 'original body text', limit: 50 });
    const matching = results.filter((r) => r.doc.id === 'dup-test');
    expect(matching.length).toBe(1);
  });

  it('clear() removes all documents', () => {
    const docs = makeDocs(20);
    svc.indexMany(docs);
    svc.clear();

    const results = svc.search({ query: 'document', limit: 50 });
    expect(results.length).toBe(0);
  });

  it('results are sorted by score descending', () => {
    const docs = makeDocs(50);
    svc.indexMany(docs);

    const results = svc.search({ query: 'body', limit: 30 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('matchType is keyword when only keyword engine fires', () => {
    const doc: SearchDoc = {
      id: 'kw-only',
      scope: 'drafts',
      body: 'supercalifragilistic keyword test',
      ts: Date.now(),
    };
    svc.index(doc);

    const results = svc.search({ query: 'supercalifragilistic', limit: 5 });
    expect(results.length).toBe(1);
    // Semantic is disabled in v1, so it can only be 'keyword'
    expect(results[0].matchType).toBe('keyword');
  });
});

// ---------------------------------------------------------------------------
// KeywordSearch (unit)
// ---------------------------------------------------------------------------

describe('KeywordSearch', () => {
  let ks: KeywordSearch;

  beforeEach(() => {
    ks = new KeywordSearch(':memory:');
  });

  it('returns empty array for an empty corpus', () => {
    expect(ks.search('anything')).toEqual([]);
  });

  it('finds a doc by an exact phrase in the body', () => {
    ks.index({
      id: 'kw-1',
      scope: 'inbox',
      body: 'the quick brown fox jumps over the lazy dog',
      ts: Date.now(),
    });

    const hits = ks.search('quick brown fox');
    expect(hits.length).toBe(1);
    expect(hits[0].doc.id).toBe('kw-1');
    expect(hits[0].matchType).toBe('keyword');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('returns no results for a query that does not match', () => {
    ks.index({
      id: 'kw-2',
      scope: 'inbox',
      body: 'hello world',
      ts: Date.now(),
    });

    const hits = ks.search('xyzzy frobnicator');
    expect(hits.length).toBe(0);
  });

  it('upsert replaces existing doc without duplicating', () => {
    const original: SearchDoc = {
      id: 'upsert-1',
      scope: 'inbox',
      body: 'original content',
      ts: Date.now(),
    };
    const updated: SearchDoc = {
      ...original,
      body: 'updated content for upsert test',
    };
    ks.index(original);
    ks.index(updated);

    // Original body should no longer match
    expect(ks.search('original content').length).toBe(0);
    // Updated body should match exactly once
    const hits = ks.search('updated content for upsert test');
    expect(hits.length).toBe(1);
    expect(hits[0].doc.body).toBe(updated.body);
  });

  it('scope filter works correctly', () => {
    ks.indexMany([
      { id: 'a', scope: 'inbox', body: 'shared word alpha', ts: 1 },
      { id: 'b', scope: 'drafts', body: 'shared word beta', ts: 2 },
      { id: 'c', scope: 'decisions', body: 'shared word gamma', ts: 3 },
    ]);

    const inboxHits = ks.search('shared word', { scope: 'inbox' });
    expect(inboxHits.length).toBe(1);
    expect(inboxHits[0].doc.scope).toBe('inbox');

    const draftsHits = ks.search('shared word', { scope: 'drafts' });
    expect(draftsHits.length).toBe(1);
    expect(draftsHits[0].doc.scope).toBe('drafts');
  });

  it('respects the limit option', () => {
    const docs: SearchDoc[] = Array.from({ length: 30 }, (_, i) => ({
      id: `limit-${i}`,
      scope: 'inbox' as SearchScope,
      body: `common term repeated ${i}`,
      ts: i,
    }));
    ks.indexMany(docs);

    const hits = ks.search('common term', { limit: 5 });
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  it('clear() empties the index', () => {
    ks.index({ id: 'c1', scope: 'inbox', body: 'clearable content', ts: 1 });
    ks.clear();
    expect(ks.search('clearable content').length).toBe(0);
  });

  it('handles FTS5-special characters in the query safely', () => {
    ks.index({
      id: 'safe-1',
      scope: 'inbox',
      body: 'phone number +31 6 12345678 contact',
      ts: Date.now(),
    });

    // '+' and '-' are FTS5 operators — sanitisation should prevent throws.
    expect(() => ks.search('+31 6 12345678')).not.toThrow();
    expect(() => ks.search('AND OR NOT')).not.toThrow();
    expect(() => ks.search('star* queries')).not.toThrow();
  });

  it('phone number query returns the correct document', () => {
    ks.index({
      id: 'phone-doc',
      scope: 'inbox',
      body: 'please call me on 0031612345678 for the appointment',
      ts: Date.now(),
    });
    ks.index({
      id: 'unrelated',
      scope: 'inbox',
      body: 'nothing related here',
      ts: Date.now(),
    });

    const hits = ks.search('0031612345678');
    expect(hits.length).toBe(1);
    expect(hits[0].doc.id).toBe('phone-doc');
    expect(hits[0].matchType).toBe('keyword');
  });
});

// ---------------------------------------------------------------------------
// SemanticSearch (unit — v1 stub behaviour)
// ---------------------------------------------------------------------------

describe('SemanticSearch (v1 stub)', () => {
  let sem: SemanticSearch;

  beforeEach(() => {
    sem = new SemanticSearch();
  });

  it('search always returns empty array in v1', () => {
    sem.index({ id: 's1', scope: 'inbox', body: 'test', ts: Date.now() });
    expect(sem.search('test')).toEqual([]);
  });

  it('index/indexMany/clear do not throw', () => {
    expect(() => sem.index({ id: 's2', scope: 'drafts', body: 'x', ts: 1 })).not.toThrow();
    expect(() =>
      sem.indexMany([{ id: 's3', scope: 'personas', body: 'y', ts: 2 }]),
    ).not.toThrow();
    expect(() => sem.clear()).not.toThrow();
  });
});
