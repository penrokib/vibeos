// =============================================================================
// rokibrain.app — Draft Row Component (M07)
// -----------------------------------------------------------------------------
// Single expandable draft row with preview, approve/reject actions.
// =============================================================================

import type { JSX } from 'react';
import type { Draft } from '../../shared/api-client';

interface DraftRowProps {
  draft: Draft;
  expanded: boolean;
  processing: boolean;
  onToggleExpand: (draftId: string) => void;
  onApprove: (draftId: string) => void;
  onReject: (draftId: string) => void;
}

export function DraftRow({
  draft,
  expanded,
  processing,
  onToggleExpand,
  onApprove,
  onReject,
}: DraftRowProps): JSX.Element {
  const createdDate = new Date(draft.created_at);
  const timeAgo = getTimeAgo(createdDate);

  return (
    <div
      className={
        'rounded-lg border transition-colors ' +
        (expanded
          ? 'border-emerald-500/30 bg-emerald-950/10'
          : 'border-neutral-800 bg-neutral-900/40 hover:border-neutral-700')
      }
    >
      {/* Collapsed header */}
      <button
        type="button"
        onClick={() => onToggleExpand(draft.id)}
        disabled={processing}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-emerald-400">
              {draft.persona_slug ?? 'unknown'}
            </span>
            <span className="text-xs text-neutral-500">→</span>
            <span className="text-xs text-neutral-400">
              {draft.contact_external_id}
            </span>
            {draft.similarity_score !== null &&
              draft.similarity_score >= 0.7 && (
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-400">
                  similar {(draft.similarity_score * 100).toFixed(0)}%
                </span>
              )}
          </div>
          <div className="text-sm text-neutral-300 line-clamp-1">
            {draft.body}
          </div>
          <div className="text-[10px] text-neutral-500">{timeAgo}</div>
        </div>
        <div className="ml-4 text-neutral-500">
          {expanded ? '▼' : '▶'}
        </div>
      </button>

      {/* Expanded preview + actions */}
      {expanded && (
        <div className="border-t border-neutral-800 px-4 py-3">
          <div className="mb-3 whitespace-pre-wrap rounded-md bg-neutral-900 p-3 text-sm text-neutral-200">
            {draft.body}
          </div>

          {draft.refused_reasons && draft.refused_reasons.length > 0 && (
            <div className="mb-3 rounded-md border border-red-900/50 bg-red-950/20 p-2">
              <div className="mb-1 text-xs font-medium text-red-400">
                Refused by anti-ban gates:
              </div>
              <ul className="space-y-1 text-[11px] text-neutral-400">
                {draft.refused_reasons.map((reason, i) => (
                  <li key={i}>• {reason}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="text-xs text-neutral-500">
              Draft ID: {draft.id.slice(0, 12)}...
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onReject(draft.id)}
                disabled={processing}
                className={
                  'rounded-md px-4 py-2 text-sm transition-colors ' +
                  (processing
                    ? 'cursor-not-allowed bg-neutral-800 text-neutral-600'
                    : 'bg-red-900/30 text-red-300 hover:bg-red-900/50')
                }
              >
                {processing ? 'Processing...' : 'Reject'}
              </button>
              <button
                type="button"
                onClick={() => onApprove(draft.id)}
                disabled={processing}
                className={
                  'rounded-md px-4 py-2 text-sm transition-colors ' +
                  (processing
                    ? 'cursor-not-allowed bg-neutral-800 text-neutral-600'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500')
                }
              >
                {processing ? 'Processing...' : 'Approve & Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}
