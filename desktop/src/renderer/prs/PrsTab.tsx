// =============================================================================
// rokibrain.app — PR queue tab (M09)
// -----------------------------------------------------------------------------
// Lists open PRs across both repos with merge gates enforced. NEVER auto-merge.
// =============================================================================

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { PrItem } from '../../shared/ipc-contracts';

export function PrsTab(): JSX.Element {
  const [prs, setPrs] = useState<PrItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState<number | null>(null);

  async function loadPrs(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const result = await window.rokibrain.prs.list();
      setPrs(result.prs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load PRs');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPrs();
  }, []);

  async function handleMerge(pr: PrItem): Promise<void> {
    if (!confirm(`Merge PR #${pr.number}: ${pr.title}?`)) return;

    setMerging(pr.number);
    try {
      const result = await window.rokibrain.prs.merge({
        repo: pr.repository,
        prNumber: pr.number,
      });

      if (result.success) {
        alert(`✅ ${result.message}`);
        void loadPrs(); // Refresh list
      } else {
        alert(`❌ ${result.message}`);
      }
    } catch (err) {
      alert(`❌ ${err instanceof Error ? err.message : 'Merge failed'}`);
    } finally {
      setMerging(null);
    }
  }

  async function handleOpenShell(pr: PrItem): Promise<void> {
    try {
      await window.rokibrain.prs.openShell({
        repo: pr.repository,
        prNumber: pr.number,
      });
    } catch (err) {
      alert(`Failed to open shell: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 20 }}>
        <p>Loading PRs...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 20 }}>
        <p style={{ color: '#ff4444' }}>Error: {error}</p>
        <button onClick={() => void loadPrs()}>Retry</button>
      </div>
    );
  }

  if (prs.length === 0) {
    return (
      <div style={{ padding: 20 }}>
        <p>No open PRs.</p>
        <button onClick={() => void loadPrs()}>Refresh</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>PR Queue</h2>
        <button onClick={() => void loadPrs()}>Refresh</button>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #333' }}>
            <th style={{ textAlign: 'left', padding: 10 }}>#</th>
            <th style={{ textAlign: 'left', padding: 10 }}>Title</th>
            <th style={{ textAlign: 'left', padding: 10 }}>Repo</th>
            <th style={{ textAlign: 'center', padding: 10 }}>Mergeable</th>
            <th style={{ textAlign: 'center', padding: 10 }}>CI</th>
            <th style={{ textAlign: 'center', padding: 10 }}>Labels</th>
            <th style={{ textAlign: 'right', padding: 10 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {prs.map((pr) => (
            <tr
              key={`${pr.repository}#${pr.number}`}
              style={{ borderBottom: '1px solid #222' }}
            >
              <td style={{ padding: 10 }}>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#58a6ff' }}
                >
                  #{pr.number}
                </a>
              </td>
              <td style={{ padding: 10 }}>
                <div>{pr.title}</div>
                <div style={{ fontSize: 12, color: '#888' }}>by {pr.author}</div>
              </td>
              <td style={{ padding: 10, fontSize: 12, color: '#888' }}>
                {pr.repository.split('/')[1]}
              </td>
              <td style={{ textAlign: 'center', padding: 10 }}>
                {pr.mergeable === 'MERGEABLE' ? '✅' : pr.mergeable === 'CONFLICTING' ? '⚠️' : '❓'}
              </td>
              <td style={{ textAlign: 'center', padding: 10 }}>
                {pr.statusCheckRollup === 'SUCCESS'
                  ? '✅'
                  : pr.statusCheckRollup === 'PENDING'
                    ? '⏳'
                    : pr.statusCheckRollup === 'FAILURE'
                      ? '❌'
                      : '—'}
              </td>
              <td style={{ textAlign: 'center', padding: 10, fontSize: 11 }}>
                {pr.labels.length > 0
                  ? pr.labels.map((l) => l.name).join(', ')
                  : '—'}
              </td>
              <td style={{ textAlign: 'right', padding: 10 }}>
                {pr.canMerge ? (
                  <button
                    onClick={() => void handleMerge(pr)}
                    disabled={merging === pr.number}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: '#238636',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      cursor: merging === pr.number ? 'wait' : 'pointer',
                    }}
                  >
                    {merging === pr.number ? 'Merging...' : 'Merge'}
                  </button>
                ) : pr.mergeable === 'CONFLICTING' ? (
                  <button
                    onClick={() => void handleOpenShell(pr)}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: '#da3633',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    Rebase needed — open shell
                  </button>
                ) : (
                  <span style={{ fontSize: 12, color: '#888' }}>
                    {pr.blockReason}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
