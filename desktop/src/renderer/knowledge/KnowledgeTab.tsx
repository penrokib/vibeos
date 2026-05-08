// =============================================================================
// rokibrain.app — Knowledge Search tab (M08)
// -----------------------------------------------------------------------------
// Search bar + filters (persona, min_score) over GET /knowledge/search.
// Results: score + snippet + persona link (jumps to Personas tab).
// Acceptance: returns ≥3 results <3s on staging.
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { apiClient, type SearchHit } from '../lib/api-client';

export function KnowledgeTab(): JSX.Element {
  const [query, setQuery] = useState('');
  const [personaFilter, setPersonaFilter] = useState('');
  const [minScore, setMinScore] = useState(0.7);
  const [topK, setTopK] = useState(20);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setError('Please enter a search query');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const hits = await apiClient.searchKnowledge({
        q: query,
        persona: personaFilter || undefined,
        top_k: topK,
        min_score: minScore,
      });
      setResults(hits);
      if (hits.length === 0) {
        setError('No results found. Try lowering the minimum score or changing filters.');
      }
    } catch (err) {
      setError((err as Error).message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, personaFilter, topK, minScore]);

  const handleJumpToPersona = useCallback((_slug: string) => {
    void window.rokibrain.tabs.switch('personas');
    // TODO M08+: broadcast persona selection event so PersonasTab can scroll to it
  }, []);

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      {/* Header */}
      <header className="border-b border-neutral-800 px-6 py-4">
        <h1 className="text-lg font-semibold text-emerald-400">Knowledge Search</h1>
        <p className="text-xs text-neutral-500">Semantic search across persona learnings + decisions</p>
      </header>

      {/* Search bar + filters */}
      <div className="border-b border-neutral-800 bg-neutral-900/40 px-6 py-4">
        <div className="flex gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search learnings and decisions..."
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleSearch}
            disabled={loading}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>

        {/* Filters row */}
        <div className="mt-3 flex gap-4 text-xs">
          <label className="flex items-center gap-2">
            <span className="text-neutral-400">Persona:</span>
            <input
              type="text"
              value={personaFilter}
              onChange={(e) => setPersonaFilter(e.target.value)}
              placeholder="e.g. ahn-cto"
              className="w-32 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100 placeholder-neutral-600 focus:border-emerald-500 focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-neutral-400">Min Score:</span>
            <input
              type="number"
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              min="0"
              max="1"
              step="0.05"
              className="w-16 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100 focus:border-emerald-500 focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-neutral-400">Top K:</span>
            <input
              type="number"
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              min="1"
              max="100"
              className="w-16 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100 focus:border-emerald-500 focus:outline-none"
            />
          </label>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {error && (
          <div className="rounded-md border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {!error && results.length === 0 && !loading && (
          <div className="text-center text-sm text-neutral-500">
            Enter a query and click Search to find relevant learnings.
          </div>
        )}

        {results.length > 0 && (
          <div className="space-y-3">
            {results.map((hit) => (
              <div
                key={hit.id}
                className="rounded-md border border-neutral-800 bg-neutral-900/60 p-4 transition-colors hover:border-neutral-700"
              >
                <div className="mb-2 flex items-start justify-between">
                  <div className="flex items-baseline gap-2">
                    <button
                      type="button"
                      onClick={() => handleJumpToPersona(hit.persona)}
                      className="text-sm font-medium text-emerald-400 hover:underline"
                    >
                      {hit.persona}
                    </button>
                    <span className="text-xs text-neutral-500">
                      {hit.sourceFile} #{hit.chunkIdx}
                    </span>
                  </div>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      hit.score >= 0.9
                        ? 'bg-emerald-900/40 text-emerald-400'
                        : hit.score >= 0.8
                          ? 'bg-sky-900/40 text-sky-400'
                          : 'bg-neutral-800 text-neutral-400'
                    }`}
                  >
                    {(hit.score * 100).toFixed(1)}%
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-neutral-300">{hit.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
