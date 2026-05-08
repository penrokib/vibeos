// =============================================================================
// rokibrain.app — Decisions Tab (M07)
// -----------------------------------------------------------------------------
// List /decisions, expand context, approve/reject via PATCH /decisions/:id.
//
// Hard walls:
//   - NEVER auto-approve (explicit user action required).
//   - All API calls via main process (renderer cannot access api-client directly).
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { Decision } from '../../shared/api-client';
import { DecisionRow } from './DecisionRow';

export function DecisionsTab(): JSX.Element {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [processing, setProcessing] = useState<Set<string>>(new Set());

  // Load decisions on mount
  useEffect(() => {
    loadDecisions();
  }, []);

  async function loadDecisions() {
    setLoading(true);
    setError(null);
    try {
      // TODO: Wire through IPC when M02 daemon is ready
      // For now, mock the data shape. The await ensures callers see loading=true
      // for at least one microtask, which is the correct async contract.
      await Promise.resolve();
      const mockDecisions: Decision[] = [];
      setDecisions(mockDecisions);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load decisions',
      );
    } finally {
      setLoading(false);
    }
  }

  async function decideOption(decisionId: string, option: string) {
    if (processing.has(decisionId)) return;

    setProcessing((prev) => new Set(prev).add(decisionId));
    try {
      // TODO: Wire through IPC to main → api-client
      // await window.rokibrain.decisions.decide(decisionId, { decided_option: option });

      // Optimistic update
      setDecisions((prev) =>
        prev.map((d) =>
          d.id === decisionId
            ? {
                ...d,
                decided_at: new Date().toISOString(),
                decided_option: option,
              }
            : d,
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to update decision',
      );
      // Rollback on error
      await loadDecisions();
    } finally {
      setProcessing((prev) => {
        const next = new Set(prev);
        next.delete(decisionId);
        return next;
      });
    }
  }

  const handleToggleExpand = useCallback((decisionId: string) => {
    setExpandedId((prev) => (prev === decisionId ? null : decisionId));
  }, []);

  const handleDecide = useCallback(
    (decisionId: string, option: string) => void decideOption(decisionId, option),
    [decisions, processing],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-2 text-sm text-neutral-400">
            Loading decisions...
          </div>
          <div className="h-1 w-48 overflow-hidden rounded-full bg-neutral-800">
            <div className="h-full w-1/2 animate-pulse bg-emerald-500" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md rounded-lg border border-red-900/50 bg-red-950/20 p-6 text-center">
          <div className="mb-2 text-sm font-medium text-red-400">Error</div>
          <div className="text-sm text-neutral-300">{error}</div>
          <button
            type="button"
            onClick={loadDecisions}
            className="mt-4 rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Separate pending and decided
  const pending = decisions.filter((d) => !d.decided_at);
  const decided = decisions.filter((d) => d.decided_at);

  if (pending.length === 0 && decided.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-1 text-sm font-medium text-neutral-400">
            No decisions
          </div>
          <div className="text-xs text-neutral-500">
            Important decisions will appear here for approval.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-white">Decisions</h1>
            <p className="text-xs text-neutral-500">
              {pending.length} pending · {decided.length} decided
            </p>
          </div>
          <button
            type="button"
            onClick={loadDecisions}
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* List */}
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-6">
          {/* Pending */}
          {pending.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
                Pending
              </h2>
              <div className="space-y-2">
                {pending.map((decision) => (
                  <DecisionRow
                    key={decision.id}
                    decision={decision}
                    expanded={expandedId === decision.id}
                    processing={processing.has(decision.id)}
                    onToggleExpand={handleToggleExpand}
                    onDecide={handleDecide}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Decided */}
          {decided.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
                Decided
              </h2>
              <div className="space-y-2">
                {decided.map((decision) => (
                  <DecisionRow
                    key={decision.id}
                    decision={decision}
                    expanded={expandedId === decision.id}
                    processing={processing.has(decision.id)}
                    onToggleExpand={handleToggleExpand}
                    onDecide={handleDecide}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
