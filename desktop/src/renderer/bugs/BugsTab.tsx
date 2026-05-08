// =============================================================================
// rokibrain.app — bugs tab (M10)
// -----------------------------------------------------------------------------
// Bug reporter UI (replaces Chrome extension on desktop). Two views:
// 1. Report: form + screenshot capture via ⌘⇧S
// 2. Past Bugs: GET /bugs?owner=me with status filter + pagination
// =============================================================================

import type { JSX } from 'react';
import { useState } from 'react';
import { BugReportForm } from './BugReportForm';
import { PastBugsList } from './PastBugsList';

type BugsView = 'report' | 'past';

export function BugsTab(): JSX.Element {
  const [view, setView] = useState<BugsView>('report');

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-white">Bug Reporter</h1>
          <p className="mt-0.5 text-xs text-neutral-400">
            Report bugs or view past submissions
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setView('report')}
            className={
              'rounded-md px-4 py-1.5 text-sm font-medium transition-colors ' +
              (view === 'report'
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-white')
            }
          >
            Report
          </button>
          <button
            type="button"
            onClick={() => setView('past')}
            className={
              'rounded-md px-4 py-1.5 text-sm font-medium transition-colors ' +
              (view === 'past'
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-white')
            }
          >
            Past Bugs
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {view === 'report' ? <BugReportForm /> : <PastBugsList />}
      </div>
    </div>
  );
}
