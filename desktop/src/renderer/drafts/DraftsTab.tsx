// =============================================================================
// rokibrain.app — Drafts Tab (M07)
// -----------------------------------------------------------------------------
// List /agency/drafts/pending, expand-row preview, approve/reject actions.
// Keyboard shortcuts: ⌘⇧A approve top, ⌘⇧R reject top.
//
// Hard walls:
//   - NEVER auto-approve (explicit user action required).
//   - All API calls via main process (renderer cannot access api-client directly).
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { Draft } from '../../shared/api-client';
import { DraftRow } from './DraftRow';

export function DraftsTab(): JSX.Element {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [processing, setProcessing] = useState<Set<string>>(new Set());

  // Load drafts on mount
  useEffect(() => {
    loadDrafts();
  }, []);

  // Keyboard shortcuts: ⌘⇧A approve top, ⌘⇧R reject top
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.shiftKey && !event.repeat) {
        if (event.key === 'A' || event.key === 'a') {
          event.preventDefault();
          approveTop();
        } else if (event.key === 'R' || event.key === 'r') {
          event.preventDefault();
          rejectTop();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drafts, processing]);

  async function loadDrafts() {
    setLoading(true);
    setError(null);
    try {
      // TODO: Wire through IPC when M02 daemon is ready
      // For now, mock the data shape. The await ensures callers see loading=true
      // for at least one microtask, which is the correct async contract.
      await Promise.resolve();
      const mockDrafts: Draft[] = [];
      setDrafts(mockDrafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load drafts');
    } finally {
      setLoading(false);
    }
  }

  async function approveDraft(draftId: string) {
    if (processing.has(draftId)) return;

    setProcessing((prev) => new Set(prev).add(draftId));
    try {
      // TODO: Wire through IPC to main → api-client
      // await window.rokibrain.drafts.approve(draftId, { approver: 'roki@dewx.com' });

      // Optimistic update
      setDrafts((prev) => prev.filter((d) => d.id !== draftId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve draft');
      // Rollback on error
      await loadDrafts();
    } finally {
      setProcessing((prev) => {
        const next = new Set(prev);
        next.delete(draftId);
        return next;
      });
    }
  }

  async function rejectDraft(draftId: string) {
    if (processing.has(draftId)) return;

    setProcessing((prev) => new Set(prev).add(draftId));
    try {
      // TODO: Wire through IPC to main → api-client
      // await window.rokibrain.drafts.reject(draftId, {});

      // Optimistic update
      setDrafts((prev) => prev.filter((d) => d.id !== draftId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject draft');
      // Rollback on error
      await loadDrafts();
    } finally {
      setProcessing((prev) => {
        const next = new Set(prev);
        next.delete(draftId);
        return next;
      });
    }
  }

  function approveTop() {
    const top = drafts[0];
    if (top && !processing.has(top.id)) {
      void approveDraft(top.id);
    }
  }

  function rejectTop() {
    const top = drafts[0];
    if (top && !processing.has(top.id)) {
      void rejectDraft(top.id);
    }
  }

  const handleToggleExpand = useCallback((draftId: string) => {
    setExpandedId((prev) => (prev === draftId ? null : draftId));
  }, []);

  const handleApprove = useCallback(
    (draftId: string) => void approveDraft(draftId),
    [drafts, processing],
  );

  const handleReject = useCallback(
    (draftId: string) => void rejectDraft(draftId),
    [drafts, processing],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-2 text-sm text-neutral-400">Loading drafts...</div>
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
            onClick={loadDrafts}
            className="mt-4 rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (drafts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-1 text-sm font-medium text-neutral-400">
            No pending drafts
          </div>
          <div className="text-xs text-neutral-500">
            Persona-authored messages will appear here for approval.
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
            <h1 className="text-lg font-semibold text-white">Drafts</h1>
            <p className="text-xs text-neutral-500">
              {drafts.length} pending · ⌘⇧A approve top · ⌘⇧R reject top
            </p>
          </div>
          <button
            type="button"
            onClick={loadDrafts}
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* List */}
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-2">
          {drafts.map((draft) => (
            <DraftRow
              key={draft.id}
              draft={draft}
              expanded={expandedId === draft.id}
              processing={processing.has(draft.id)}
              onToggleExpand={handleToggleExpand}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
