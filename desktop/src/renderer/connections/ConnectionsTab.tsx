// =============================================================================
// rokibrain.app — Connections Tab (cycle 7 / M02 visible-slice)
// -----------------------------------------------------------------------------
// Shows each daemon-supervised child (wa / tg / discord / email / linkedin)
// with its live status + a restart button.  "+ Add account" opens a stub modal
// that lists the 5 supported platforms and defers the real pair flow to
// cycles 12 / 14–15.
//
// Hard walls:
//   - Renderer accesses daemon ONLY via window.rokibrain.daemon.* (contextBridge).
//   - NO real pair flow in this PR — stub modal only.
//   - NO new IPC channels added here; all channels live in ipc-contracts.ts + main.
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type {
  ChildLifecycleState,
  ChildStatusSummary,
  MeshChildKind,
  SupervisorStatusPayload,
} from '../../shared/ipc-contracts';

const REFRESH_MS = 15_000;

// ---- platform metadata ------------------------------------------------------

interface PlatformMeta {
  kind: MeshChildKind;
  label: string;
  /** Unicode emoji used as icon (no external dep). */
  icon: string;
}

const PLATFORMS: PlatformMeta[] = [
  { kind: 'wa', label: 'WhatsApp', icon: '💬' },
  { kind: 'tg', label: 'Telegram', icon: '✈️' },
  { kind: 'discord', label: 'Discord', icon: '🎮' },
  { kind: 'email', label: 'Email', icon: '✉️' },
  { kind: 'linkedin', label: 'LinkedIn', icon: '🔗' },
];

function platformLabel(platform: string): string {
  return PLATFORMS.find((p) => p.kind === platform)?.label ?? platform;
}

function platformIcon(platform: string): string {
  return PLATFORMS.find((p) => p.kind === platform)?.icon ?? '🔌';
}

// ---- status display ---------------------------------------------------------

function statusColour(state: ChildLifecycleState): string {
  switch (state) {
    case 'running':
      return 'bg-emerald-400';
    case 'starting':
    case 'restarting':
      return 'bg-amber-400';
    case 'crashing':
    case 'permanently-failed':
      return 'bg-red-500';
    case 'stopping':
    case 'stopped':
    case 'paused':
      return 'bg-neutral-500';
    default:
      return 'bg-neutral-600';
  }
}

function statusLabel(state: ChildLifecycleState): string {
  switch (state) {
    case 'running':
      return 'connected';
    case 'starting':
      return 'starting…';
    case 'restarting':
      return 'restarting…';
    case 'crashing':
      return 'crashing';
    case 'permanently-failed':
      return 'failed';
    case 'stopping':
      return 'stopping…';
    case 'stopped':
      return 'stopped';
    case 'paused':
      return 'paused';
    default:
      return state;
  }
}

// ---- sub-components ---------------------------------------------------------

function ChildCard({
  child,
  restarting,
  onRestart,
}: {
  child: ChildStatusSummary;
  restarting: boolean;
  onRestart: (id: string) => void;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-xl" aria-hidden="true">
          {platformIcon(child.platform)}
        </span>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white">{child.id}</span>
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">
              {platformLabel(child.platform)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span
              className={`inline-block h-2 w-2 rounded-full ${statusColour(child.state)}`}
              aria-label={child.state}
            />
            <span className="text-xs text-neutral-400">{statusLabel(child.state)}</span>
            {child.restartCount > 0 ? (
              <span className="text-xs text-neutral-500">
                · {child.restartCount} restart{child.restartCount === 1 ? '' : 's'}
              </span>
            ) : null}
            {child.lastError ? (
              <span className="max-w-xs truncate text-xs text-red-400" title={child.lastError}>
                · {child.lastError}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <button
        type="button"
        disabled={restarting}
        onClick={() => onRestart(child.id)}
        className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {restarting ? 'Restarting…' : 'Restart'}
      </button>
    </div>
  );
}

// ---- add-account modal ------------------------------------------------------

function AddAccountModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [selected, setSelected] = useState<MeshChildKind | null>(null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Add account"
    >
      <div className="w-96 rounded-xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Add account</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-800 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {selected === null ? (
          <>
            <p className="mb-4 text-xs text-neutral-500">
              Choose a platform to pair a new account.
            </p>
            <ul className="space-y-2">
              {PLATFORMS.map((p) => (
                <li key={p.kind}>
                  <button
                    type="button"
                    onClick={() => setSelected(p.kind)}
                    className="flex w-full items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-left hover:border-emerald-700/50 hover:bg-neutral-800/70"
                  >
                    <span className="text-xl" aria-hidden="true">
                      {p.icon}
                    </span>
                    <span className="text-sm text-neutral-200">{p.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <span className="text-4xl" aria-hidden="true">
              {platformIcon(selected)}
            </span>
            <p className="text-sm font-medium text-neutral-200">
              {platformLabel(selected)} pair flow
            </p>
            <p className="text-xs text-neutral-500">
              Pair flow coming soon — see cycles 12 / 14–15 for the first bridges.
            </p>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="mt-2 rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700"
            >
              ← Back
            </button>
          </div>
        )}

        <div className="mt-4 border-t border-neutral-800 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md bg-neutral-800 py-2 text-sm text-neutral-400 hover:bg-neutral-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- main tab ---------------------------------------------------------------

export function ConnectionsTab(): JSX.Element {
  const [supervisorState, setSupervisorState] = useState<SupervisorStatusPayload>({
    wsPort: 0,
    uptime: 0,
    emergencyStopped: false,
    children: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<Set<string>>(new Set());
  const [restartFeedback, setRestartFeedback] = useState<Record<string, string>>({});
  const [showAddModal, setShowAddModal] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const snapshot = await window.rokibrain.daemon.getSupervisorStatus();
      setSupervisorState(snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reach daemon supervisor');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + periodic poll.
  useEffect(() => {
    void loadStatus();
    const id = window.setInterval(() => {
      void loadStatus();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadStatus]);

  // Subscribe to live pushes from the daemon supervisor.
  useEffect(() => {
    const off = window.rokibrain.daemon.onSupervisorStatus((snapshot) => {
      setSupervisorState(snapshot);
      setError(null);
    });
    return off;
  }, []);

  const handleRestart = useCallback(
    async (id: string) => {
      if (restarting.has(id)) return;
      setRestarting((prev) => new Set(prev).add(id));
      try {
        await window.rokibrain.daemon.restartChild({ childId: id });
        setRestartFeedback((prev) => ({ ...prev, [id]: 'Restart queued' }));
        // Clear feedback after 3 s then re-fetch.
        setTimeout(() => {
          setRestartFeedback((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }, 3000);
        void loadStatus();
      } catch (err) {
        setRestartFeedback((prev) => ({
          ...prev,
          [id]: err instanceof Error ? err.message : 'Restart failed',
        }));
      } finally {
        setRestarting((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [restarting, loadStatus],
  );

  const { children } = supervisorState;

  return (
    <>
      <div className="flex h-full flex-col">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-white">Connections</h1>
            <p className="text-xs text-neutral-500">
              {loading
                ? 'Loading…'
                : error
                  ? 'Supervisor unreachable'
                  : `${children.length} account${children.length === 1 ? '' : 's'} · refreshes every 15 s`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadStatus()}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
            >
              + Add account
            </button>
          </div>
        </header>

        {/* Error banner */}
        {error ? (
          <div className="border-b border-red-900/50 bg-red-950/20 px-6 py-2 text-xs text-red-300">
            daemon supervisor unreachable: {error}
          </div>
        ) : null}

        {/* Body */}
        <div className="flex-1 overflow-auto p-6">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mb-2 text-sm text-neutral-400">Loading connections…</div>
                <div className="h-1 w-48 overflow-hidden rounded-full bg-neutral-800">
                  <div className="h-full w-1/2 animate-pulse bg-emerald-500" />
                </div>
              </div>
            </div>
          ) : children.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-sm text-center">
                <div className="mb-2 text-4xl" aria-hidden="true">
                  🔌
                </div>
                <p className="mb-1 text-sm font-medium text-neutral-300">No accounts paired yet</p>
                <p className="text-xs text-neutral-500">
                  Tap{' '}
                  <span className="font-medium text-emerald-400">+ Add account</span> to pair
                  WhatsApp / Telegram / Email / Discord / LinkedIn.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {children.map((child) => (
                <div key={child.id}>
                  <ChildCard
                    child={child}
                    restarting={restarting.has(child.id)}
                    onRestart={(id) => void handleRestart(id)}
                  />
                  {restartFeedback[child.id] ? (
                    <p className="mt-1 px-1 text-xs text-neutral-500">
                      {restartFeedback[child.id]}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add account modal */}
      {showAddModal ? (
        <AddAccountModal onClose={() => setShowAddModal(false)} />
      ) : null}
    </>
  );
}
