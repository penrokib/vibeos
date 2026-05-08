// =============================================================================
// rokibrain.app — Drafts Tab (Cycle 17)
// -----------------------------------------------------------------------------
// List /agency/drafts/pending, expand-row preview, approve/reject actions.
// Keyboard shortcuts: ⌘⇧A approve top, ⌘⇧R reject top.
//
// Cycle 17 changes:
//   - Approve button now calls window.rokibrain.drafts.approve() via real IPC.
//   - Reject button calls window.rokibrain.drafts.reject() via real IPC.
//   - Draft list loaded via window.rokibrain.drafts.list().
//   - Refusal surfaces inline as a red badge with reason text.
//   - Toast on success (sent).
//   - NEVER optimistic for send — row only removed on confirmed 'sent' result.
//
// Hard walls:
//   - NEVER auto-approve (explicit user action required).
//   - Refusal UI must surface the reason text (never silently drop).
//   - All API calls via main process IPC (renderer cannot access api-client directly).
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftItem, DraftApproveResult } from '../../shared/ipc-contracts';
import { DraftRow } from './DraftRow';

interface DraftItemWithState extends DraftItem {
  /** Set when the last approve attempt was refused (anti-ban gate). */
  refusalReason?: string;
}

/** Simple toast notification. */
interface Toast {
  id: string;
  message: string;
  kind: 'success' | 'error';
}

export function DraftsTab(): JSX.Element {
  const [drafts, setDrafts] = useState<DraftItemWithState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    void loadDrafts();
    return () => {
      // Clean up toast timers on unmount
      for (const timer of toastTimers.current.values()) {
        clearTimeout(timer);
      }
    };
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

  function showToast(message: string, kind: 'success' | 'error') {
    const id = `toast_${Date.now()}_${Math.random()}`;
    const toast: Toast = { id, message, kind };
    setToasts((prev) => [...prev, toast]);

    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimers.current.delete(id);
    }, 3500);
    toastTimers.current.set(id, timer);
  }

  async function loadDrafts() {
    setLoading(true);
    setError(null);
    try {
      const result = await window.rokibrain.drafts.list();
      setDrafts(result.drafts.map((d) => ({ ...d })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load drafts');
    } finally {
      setLoading(false);
    }
  }

  async function approveDraft(draftId: string) {
    if (processing.has(draftId)) return;

    setProcessing((prev) => new Set(prev).add(draftId));
    // Clear any previous refusal badge for this draft
    setDrafts((prev) =>
      prev.map((d) => (d.id === draftId ? { ...d, refusalReason: undefined } : d)),
    );

    let result: DraftApproveResult;
    try {
      result = await window.rokibrain.drafts.approve({ draftId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send draft';
      setError(msg);
      setProcessing((prev) => {
        const next = new Set(prev);
        next.delete(draftId);
        return next;
      });
      return;
    }

    setProcessing((prev) => {
      const next = new Set(prev);
      next.delete(draftId);
      return next;
    });

    if (result.status === 'sent') {
      // Remove from list — confirmed sent
      setDrafts((prev) => prev.filter((d) => d.id !== draftId));
      showToast('Message sent', 'success');
    } else if (result.status === 'refused') {
      // Surface refusal inline — row stays, red badge shows reason
      const reason = result.reason ?? 'send refused by anti-ban gate';
      setDrafts((prev) =>
        prev.map((d) => (d.id === draftId ? { ...d, refusalReason: reason } : d)),
      );
      showToast(`Refused: ${reason}`, 'error');
    } else {
      // status === 'error'
      const reason = result.reason ?? 'send error';
      setError(`Send failed: ${reason}`);
      showToast(`Send error: ${reason}`, 'error');
    }
  }

  async function rejectDraft(draftId: string) {
    if (processing.has(draftId)) return;

    setProcessing((prev) => new Set(prev).add(draftId));
    try {
      await window.rokibrain.drafts.reject({ draftId });
      setDrafts((prev) => prev.filter((d) => d.id !== draftId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject draft');
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
            onClick={() => void loadDrafts()}
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
      {/* Toast container */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={[
                'rounded-md px-4 py-2 text-sm shadow-lg',
                t.kind === 'success'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-red-700 text-white',
              ].join(' ')}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}

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
            onClick={() => void loadDrafts()}
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
            <div key={draft.id}>
              {/* Refusal badge — shown when last approve was refused */}
              {draft.refusalReason && (
                <div className="mb-1 flex items-center gap-1.5 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  <span className="text-xs text-red-400">
                    Refused: {draft.refusalReason}
                  </span>
                </div>
              )}
              <DraftRow
                draft={draft}
                expanded={expandedId === draft.id}
                processing={processing.has(draft.id)}
                onToggleExpand={handleToggleExpand}
                onApprove={handleApprove}
                onReject={handleReject}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
