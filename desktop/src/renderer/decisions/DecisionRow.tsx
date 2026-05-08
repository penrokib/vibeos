// =============================================================================
// rokibrain.app — Decision Row Component (M07)
// -----------------------------------------------------------------------------
// Single expandable decision row with context, options, and action buttons.
// =============================================================================

import type { JSX } from 'react';
import type { Decision } from '../../shared/api-client';

interface DecisionRowProps {
  decision: Decision;
  expanded: boolean;
  processing: boolean;
  onToggleExpand: (decisionId: string) => void;
  onDecide: (decisionId: string, option: string) => void;
}

export function DecisionRow({
  decision,
  expanded,
  processing,
  onToggleExpand,
  onDecide,
}: DecisionRowProps): JSX.Element {
  const createdDate = new Date(decision.created_at);
  const timeAgo = getTimeAgo(createdDate);
  const isPending = !decision.decided_at;

  const priorityColors = {
    P0: 'bg-red-500/20 text-red-400 border-red-500/30',
    P1: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    P2: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
    P3: 'bg-neutral-500/20 text-neutral-400 border-neutral-500/30',
  };

  return (
    <div
      className={
        'rounded-lg border transition-colors ' +
        (expanded
          ? 'border-emerald-500/30 bg-emerald-950/10'
          : isPending
            ? 'border-neutral-800 bg-neutral-900/40 hover:border-neutral-700'
            : 'border-neutral-800/50 bg-neutral-900/20')
      }
    >
      {/* Collapsed header */}
      <button
        type="button"
        onClick={() => onToggleExpand(decision.id)}
        disabled={processing}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-md border px-2 py-0.5 text-[10px] font-medium ${priorityColors[decision.priority]}`}
            >
              {decision.priority}
            </span>
            <span className="text-xs font-medium text-emerald-400">
              {decision.persona}
            </span>
            {!isPending && decision.decided_option && (
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-400">
                ✓ {decision.decided_option}
              </span>
            )}
          </div>
          <div className="text-sm text-neutral-300">{decision.title}</div>
          <div className="text-[10px] text-neutral-500">{timeAgo}</div>
        </div>
        <div className="ml-4 text-neutral-500">
          {expanded ? '▼' : '▶'}
        </div>
      </button>

      {/* Expanded context + actions */}
      {expanded && (
        <div className="border-t border-neutral-800 px-4 py-3">
          {decision.context && (
            <div className="mb-3 whitespace-pre-wrap rounded-md bg-neutral-900 p-3 text-sm text-neutral-200">
              {decision.context}
            </div>
          )}

          {isPending ? (
            <div>
              <div className="mb-2 text-xs font-medium text-neutral-400">
                Options:
              </div>
              <div className="flex flex-wrap gap-2">
                {decision.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onDecide(decision.id, option)}
                    disabled={processing}
                    className={
                      'rounded-md px-4 py-2 text-sm transition-colors ' +
                      (processing
                        ? 'cursor-not-allowed bg-neutral-800 text-neutral-600'
                        : option.toLowerCase() === 'approve'
                          ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                          : option.toLowerCase() === 'reject'
                            ? 'bg-red-900/30 text-red-300 hover:bg-red-900/50'
                            : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700')
                    }
                  >
                    {processing ? 'Processing...' : option}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-950/20 p-2 text-xs text-emerald-300">
              Decided: <span className="font-medium">{decision.decided_option}</span>
              {decision.decided_at && (
                <span className="ml-2 text-neutral-500">
                  ({getTimeAgo(new Date(decision.decided_at))})
                </span>
              )}
            </div>
          )}

          <div className="mt-2 text-xs text-neutral-500">
            Decision ID: {decision.id.slice(0, 12)}...
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
