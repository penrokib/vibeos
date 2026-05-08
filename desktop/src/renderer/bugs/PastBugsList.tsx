// =============================================================================
// rokibrain.app — past bugs list (M10)
// -----------------------------------------------------------------------------
// GET /bugs?owner=me with status filter + pagination. Click → details modal.
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { BugStatus, ListBugsInput, PastBug } from '../../shared/ipc-contracts';

const STATUSES: readonly BugStatus[] = ['open', 'in-progress', 'resolved', 'closed', 'duplicate'];

export function PastBugsList(): JSX.Element {
  const [bugs, setBugs] = useState<PastBug[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<BugStatus | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const [selectedBug, setSelectedBug] = useState<PastBug | null>(null);

  const limit = 20;

  const fetchBugs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const input: ListBugsInput = {
        owner: 'me',
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit,
        offset,
      };
      const result = await window.rokibrain.bugs.list(input);
      setBugs(result.bugs);
      setTotal(result.total);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, offset]);

  useEffect(() => {
    void fetchBugs();
  }, [fetchBugs]);

  const handleStatusChange = useCallback((status: BugStatus | 'all') => {
    setStatusFilter(status);
    setOffset(0);
  }, []);

  const handleNextPage = useCallback(() => {
    if (offset + limit < total) {
      setOffset(offset + limit);
    }
  }, [offset, total]);

  const handlePrevPage = useCallback(() => {
    if (offset > 0) {
      setOffset(Math.max(0, offset - limit));
    }
  }, [offset]);

  return (
    <div className="flex h-full flex-col px-6 py-6">
      {/* Filter */}
      <div className="mb-4 flex items-center gap-4">
        <label htmlFor="status-filter" className="text-sm font-medium text-neutral-300">
          Status:
        </label>
        <select
          id="status-filter"
          value={statusFilter}
          onChange={(e) => handleStatusChange(e.target.value as BugStatus | 'all')}
          className="rounded-md border border-neutral-700 bg-neutral-900/50 px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
        >
          <option value="all">All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void fetchBugs()}
          className="ml-auto rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
        >
          Refresh
        </button>
      </div>

      {/* Loading / Error */}
      {loading && <div className="text-sm text-neutral-400">Loading bugs...</div>}
      {error && (
        <div className="rounded-md bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Error: {error}
        </div>
      )}

      {/* List */}
      {!loading && !error && bugs.length === 0 && (
        <div className="text-sm text-neutral-500">No bugs found.</div>
      )}
      {!loading && !error && bugs.length > 0 && (
        <>
          <div className="flex-1 space-y-2 overflow-auto">
            {bugs.map((bug) => (
              <button
                key={bug.id}
                type="button"
                onClick={() => setSelectedBug(bug)}
                className="flex w-full items-start gap-4 rounded-md border border-neutral-700 bg-neutral-900/30 px-4 py-3 text-left transition-colors hover:border-emerald-500/50 hover:bg-neutral-800/50"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{bug.title}</span>
                    <span
                      className={
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ' +
                        (bug.severity === 'P0'
                          ? 'bg-red-500/20 text-red-300'
                          : bug.severity === 'P1'
                            ? 'bg-orange-500/20 text-orange-300'
                            : bug.severity === 'P2'
                              ? 'bg-yellow-500/20 text-yellow-300'
                              : 'bg-neutral-500/20 text-neutral-300')
                      }
                    >
                      {bug.severity}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-neutral-500">
                    <span>Status: {bug.status}</span>
                    <span>Created: {new Date(bug.createdAt).toLocaleDateString()}</span>
                    {bug.resolvedAt && (
                      <span>Resolved: {new Date(bug.resolvedAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
                <svg
                  className="h-5 w-5 text-neutral-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </button>
            ))}
          </div>

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-between border-t border-neutral-800 pt-4 text-sm text-neutral-400">
            <div>
              Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handlePrevPage}
                disabled={offset === 0}
                className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={handleNextPage}
                disabled={offset + limit >= total}
                className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {/* Details Modal */}
      {selectedBug && (
        <BugDetailModal bug={selectedBug} onClose={() => setSelectedBug(null)} />
      )}
    </div>
  );
}

function BugDetailModal({ bug, onClose }: { bug: PastBug; onClose: () => void }): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl rounded-lg border border-neutral-700 bg-neutral-900 p-6 shadow-xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 text-neutral-500 hover:text-white"
        >
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <h2 className="text-xl font-semibold text-white">{bug.title}</h2>

        <div className="mt-4 space-y-3 text-sm">
          <div className="flex items-center gap-4">
            <span className="text-neutral-400">Severity:</span>
            <span
              className={
                'rounded px-2 py-0.5 text-xs font-semibold uppercase ' +
                (bug.severity === 'P0'
                  ? 'bg-red-500/20 text-red-300'
                  : bug.severity === 'P1'
                    ? 'bg-orange-500/20 text-orange-300'
                    : bug.severity === 'P2'
                      ? 'bg-yellow-500/20 text-yellow-300'
                      : 'bg-neutral-500/20 text-neutral-300')
              }
            >
              {bug.severity}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-neutral-400">Status:</span>
            <span className="text-white">{bug.status}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-neutral-400">Created:</span>
            <span className="text-white">{new Date(bug.createdAt).toLocaleString()}</span>
          </div>
          {bug.resolvedAt && (
            <div className="flex items-center gap-4">
              <span className="text-neutral-400">Resolved:</span>
              <span className="text-white">{new Date(bug.resolvedAt).toLocaleString()}</span>
            </div>
          )}
        </div>

        <div className="mt-6">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
