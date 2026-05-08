// =============================================================================
// rokibrain.app — Personas Browser tab (M08)
// -----------------------------------------------------------------------------
// Tree view: 8 cockpit, ~73 fleshed, dormant collapsed.
// Per-persona: identity preview, last activity, current task, outbox tail,
// "Nudge now" → POST /agency/personas/:slug/nudge.
// Status filter: active/idle/blocked/escalated/account-locked (derived from
// tabAlive + currentTask + lastActiveAt).
// Acceptance: renders ≥73 personas with status colors.
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiClient, type PersonaDetail, type PersonaSummary } from '../lib/api-client';

type StatusFilter = 'all' | 'active' | 'idle' | 'blocked' | 'dormant';

function deriveStatus(p: PersonaSummary): StatusFilter {
  if (!p.tabAlive && !p.lastActiveAt) return 'dormant';
  if (p.tabAlive && p.currentTask) return 'active';
  if (p.tabAlive && !p.currentTask) return 'idle';
  if (!p.tabAlive && p.lastActiveAt) return 'blocked';
  return 'idle';
}

function statusColor(s: StatusFilter): string {
  switch (s) {
    case 'active':
      return 'bg-emerald-500';
    case 'idle':
      return 'bg-sky-500';
    case 'blocked':
      return 'bg-amber-500';
    case 'dormant':
      return 'bg-neutral-600';
    default:
      return 'bg-neutral-500';
  }
}

export function PersonasTab(): JSX.Element {
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonaDetail | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nudging, setNudging] = useState(false);

  useEffect(() => {
    void loadPersonas();
  }, []);

  const loadPersonas = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiClient.listPersonas({ limit: 500 });
      setPersonas(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (slug: string) => {
    setDetailLoading(true);
    setSelectedSlug(slug);
    try {
      const d = await apiClient.getPersona(slug);
      setDetail(d);
    } catch (err) {
      setError((err as Error).message);
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleNudge = useCallback(async () => {
    if (!selectedSlug) return;
    setNudging(true);
    try {
      await apiClient.nudgePersona(selectedSlug);
      // Refresh detail after nudge
      await loadDetail(selectedSlug);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setNudging(false);
    }
  }, [selectedSlug, loadDetail]);

  const filtered = personas.filter((p) => {
    if (filter === 'all') return true;
    return deriveStatus(p) === filter;
  });

  // Group by layer for tree structure
  const byLayer = filtered.reduce(
    (acc, p) => {
      const layer = p.layer === 'unknown' ? 'specialist' : p.layer;
      if (!acc[layer]) acc[layer] = [];
      acc[layer].push(p);
      return acc;
    },
    {} as Record<string, PersonaSummary[]>,
  );

  const layerOrder: Array<string> = ['c-level', 'senior-manager', 'lead', 'coordinator', 'specialist'];

  return (
    <div className="flex h-full bg-neutral-950 text-neutral-100">
      {/* Left: Tree */}
      <div className="w-80 border-r border-neutral-800 flex flex-col">
        <header className="border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-emerald-400">Personas</h2>
          <p className="text-xs text-neutral-500">{filtered.length} total</p>
        </header>

        {/* Status filter */}
        <div className="border-b border-neutral-800 bg-neutral-900/40 px-4 py-2">
          <div className="flex flex-wrap gap-1 text-xs">
            {(['all', 'active', 'idle', 'blocked', 'dormant'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded px-2 py-1 transition-colors ${
                  filter === f
                    ? 'bg-emerald-600 text-white'
                    : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-auto px-2 py-2">
          {loading && <div className="text-center text-xs text-neutral-500">Loading...</div>}
          {error && <div className="text-xs text-red-400">{error}</div>}
          {!loading &&
            layerOrder.map((layer) => {
              const ps = byLayer[layer];
              if (!ps || ps.length === 0) return null;
              return (
                <div key={layer} className="mb-3">
                  <div className="mb-1 text-xs font-medium uppercase text-neutral-500">{layer}</div>
                  <div className="space-y-0.5">
                    {ps.map((p) => {
                      const status = deriveStatus(p);
                      return (
                        <button
                          key={p.slug}
                          type="button"
                          onClick={() => loadDetail(p.slug)}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                            selectedSlug === p.slug
                              ? 'bg-emerald-900/40 text-emerald-300'
                              : 'text-neutral-300 hover:bg-neutral-800'
                          }`}
                        >
                          <span className={`h-2 w-2 rounded-full ${statusColor(status)}`} />
                          <span className="flex-1 truncate">{p.slug}</span>
                          {p.outboxUnread > 0 && (
                            <span className="rounded bg-sky-900/50 px-1 text-[10px] text-sky-400">
                              {p.outboxUnread}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* Right: Detail */}
      <div className="flex-1 flex flex-col overflow-auto">
        {!selectedSlug && (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Select a persona to view details
          </div>
        )}

        {selectedSlug && detailLoading && (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Loading {selectedSlug}...
          </div>
        )}

        {selectedSlug && !detailLoading && detail && (
          <div className="p-6">
            {/* Header */}
            <div className="mb-6 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-emerald-400">{detail.slug}</h2>
                <div className="mt-1 flex gap-3 text-xs text-neutral-500">
                  <span>layer: {detail.layer}</span>
                  <span>account: {detail.account}</span>
                  {detail.reportsTo && <span>reports to: {detail.reportsTo}</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={handleNudge}
                disabled={nudging}
                className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                {nudging ? 'Nudging...' : 'Nudge now'}
              </button>
            </div>

            {/* Status row */}
            <div className="mb-6 grid grid-cols-3 gap-4 rounded border border-neutral-800 bg-neutral-900/40 p-4 text-xs">
              <div>
                <div className="text-neutral-500">Tab Alive</div>
                <div className={detail.tabAlive ? 'text-emerald-400' : 'text-neutral-400'}>
                  {detail.tabAlive ? 'Yes' : 'No'}
                </div>
              </div>
              <div>
                <div className="text-neutral-500">Last Active</div>
                <div className="text-neutral-300">
                  {detail.lastActiveAt
                    ? new Date(detail.lastActiveAt).toLocaleString()
                    : 'Never'}
                </div>
              </div>
              <div>
                <div className="text-neutral-500">Model</div>
                <div className="text-neutral-300">{detail.model ?? 'N/A'}</div>
              </div>
            </div>

            {/* Current task */}
            {detail.currentTask && (
              <div className="mb-6">
                <h3 className="mb-2 text-sm font-medium text-neutral-400">Current Task</h3>
                <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3 text-sm text-neutral-300">
                  {detail.currentTask}
                </div>
              </div>
            )}

            {/* Identity preview */}
            <div className="mb-6">
              <h3 className="mb-2 text-sm font-medium text-neutral-400">Identity</h3>
              <div className="max-h-40 overflow-auto rounded border border-neutral-800 bg-neutral-900/40 p-3 font-mono text-xs text-neutral-300 whitespace-pre-wrap">
                {detail.identity}
              </div>
            </div>

            {/* Outbox tail */}
            {detail.outboxTail.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-neutral-400">Recent Outbox</h3>
                <div className="space-y-2">
                  {detail.outboxTail.map((msg, i) => (
                    <div
                      key={i}
                      className="rounded border border-neutral-800 bg-neutral-900/40 p-3 text-sm text-neutral-300"
                    >
                      {msg}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Stats */}
            <div className="mt-6 grid grid-cols-3 gap-4 rounded border border-neutral-800 bg-neutral-900/40 p-4 text-xs">
              <div>
                <div className="text-neutral-500">Lifetime Tasks</div>
                <div className="text-neutral-300">{detail.lifetimeTaskCount}</div>
              </div>
              <div>
                <div className="text-neutral-500">Current Iter</div>
                <div className="text-neutral-300">{detail.currentIterCount}</div>
              </div>
              <div>
                <div className="text-neutral-500">Inbox Depth</div>
                <div className="text-neutral-300">{detail.inboxDepth}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
