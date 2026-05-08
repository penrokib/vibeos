// =============================================================================
// rokibrain.app — bug report form (M10)
// -----------------------------------------------------------------------------
// Form: title, severity (P0–P3), description, auto-screenshot (⌘⇧S), context
// auto-fill (app version, OS, active tab). Submit → multipart POST /bugs.
// NEVER auto-submits — explicit click only.
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type {
  BugContext,
  BugSeverity,
  CaptureScreenshotPayload,
  ConsoleEntry,
  SubmitBugInput,
  TabId,
} from '../../shared/ipc-contracts';

const SEVERITIES: readonly BugSeverity[] = ['P0', 'P1', 'P2', 'P3'];

export function BugReportForm(): JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<BugSeverity>('P2');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [context, setContext] = useState<BugContext | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  // Auto-fill context on mount.
  useEffect(() => {
    const ctx: BugContext = {
      appVersion: window.rokibrain.app.version,
      os: window.rokibrain.app.platform,
      platform: window.rokibrain.app.platform,
      activeTab: 'bugs' as TabId,
      capturedAt: new Date().toISOString(),
    };
    setContext(ctx);
  }, []);

  // Capture screenshot handler.
  const handleCapture = useCallback(async () => {
    try {
      const result: CaptureScreenshotPayload = await window.rokibrain.bugs.capture();
      setScreenshot(result.dataUrl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Screenshot capture failed: ${msg}\n\nMake sure screen recording permission is granted in System Preferences > Privacy & Security.`);
    }
  }, []);

  // Submit handler.
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!title.trim()) {
        alert('Title is required.');
        return;
      }
      if (!context) {
        alert('Context not initialized.');
        return;
      }

      setSubmitting(true);
      setResult(null);

      try {
        const input: SubmitBugInput = {
          title: title.trim(),
          description: description.trim(),
          severity,
          screenshotDataUrl: screenshot ?? undefined,
          context,
          consoleLog: [] as ConsoleEntry[],
        };

        const res = await window.rokibrain.bugs.submit(input);

        if (res.success) {
          setResult({ success: true, message: `Bug ${res.bugId ?? ''} created successfully.` });
          // Reset form.
          setTitle('');
          setDescription('');
          setSeverity('P2');
          setScreenshot(null);
        } else {
          setResult({ success: false, message: res.error ?? 'Unknown error.' });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setResult({ success: false, message: msg });
      } finally {
        setSubmitting(false);
      }
    },
    [title, description, severity, screenshot, context],
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Title */}
        <div>
          <label htmlFor="bug-title" className="block text-sm font-medium text-neutral-300">
            Title <span className="text-red-400">*</span>
          </label>
          <input
            id="bug-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Brief description of the bug"
            className="mt-1.5 w-full rounded-md border border-neutral-700 bg-neutral-900/50 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            required
          />
        </div>

        {/* Severity */}
        <div>
          <label htmlFor="bug-severity" className="block text-sm font-medium text-neutral-300">
            Severity
          </label>
          <select
            id="bug-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as BugSeverity)}
            className="mt-1.5 w-full rounded-md border border-neutral-700 bg-neutral-900/50 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s} {s === 'P0' ? '(Critical)' : s === 'P1' ? '(High)' : s === 'P2' ? '(Medium)' : '(Low)'}
              </option>
            ))}
          </select>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="bug-description" className="block text-sm font-medium text-neutral-300">
            Description
          </label>
          <textarea
            id="bug-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Steps to reproduce, expected vs actual behavior, etc."
            rows={6}
            className="mt-1.5 w-full rounded-md border border-neutral-700 bg-neutral-900/50 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        {/* Screenshot */}
        <div>
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-neutral-300">Screenshot</label>
            <button
              type="button"
              onClick={handleCapture}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              Capture (⌘⇧S)
            </button>
          </div>
          {screenshot ? (
            <div className="relative mt-2 overflow-hidden rounded-md border border-neutral-700">
              <img src={screenshot} alt="Screenshot preview" className="w-full" />
              <button
                type="button"
                onClick={() => setScreenshot(null)}
                className="absolute right-2 top-2 rounded bg-red-500/80 px-2 py-1 text-xs text-white hover:bg-red-600"
              >
                Remove
              </button>
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-neutral-500">
              No screenshot captured. Press ⌘⇧S or click Capture above.
            </p>
          )}
        </div>

        {/* Context (read-only) */}
        {context && (
          <div>
            <label className="block text-sm font-medium text-neutral-300">Context (auto-filled)</label>
            <div className="mt-1.5 space-y-1 rounded-md border border-neutral-700 bg-neutral-900/30 px-3 py-2 text-xs text-neutral-400">
              <div>App Version: {context.appVersion}</div>
              <div>OS: {context.os}</div>
              <div>Platform: {context.platform}</div>
              <div>Active Tab: {context.activeTab}</div>
            </div>
          </div>
        )}

        {/* Result */}
        {result && (
          <div
            className={
              'rounded-md px-4 py-3 text-sm ' +
              (result.success
                ? 'bg-emerald-500/10 text-emerald-300'
                : 'bg-red-500/10 text-red-300')
            }
          >
            {result.message}
          </div>
        )}

        {/* Submit */}
        <div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Submitting...' : 'Submit Bug Report'}
          </button>
        </div>
      </form>
    </div>
  );
}
