// =============================================================================
// rokibrain.app — Settings tab (M12)
// -----------------------------------------------------------------------------
// Settings UI:
//   - BFF endpoint config (default https://app.rokibrain.com)
//   - JWT login state (enrolled, unenrolled, expired)
//   - GitHub token field
//   - Hotkey customization (v1: read-only, v2: editable)
//   - Data export
//
// Hard walls: NEVER show plaintext master DEK or JWT (only show state/email).
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { AuthStatusPayload } from '../../shared/ipc-contracts';

// Sponsor links — hardcoded, https only.
const SPONSOR_LINKS = [
  { label: 'GitHub Sponsors', url: 'https://github.com/sponsors/penrokib' },
  { label: 'Patreon', url: 'https://patreon.com/penrokib' },
  { label: 'Open Collective', url: 'https://opencollective.com/vibeos' },
] as const;

// What we collect bullets for the telemetry modal.
const TELEMETRY_COLLECT = [
  'Stack trace (file:line)',
  'App version',
  'Operating system name + version',
  'Locale',
  'Error class name',
];

const TELEMETRY_NEVER_COLLECT = [
  'Messages or conversation content',
  'Account names or contact names',
  'Personal data of any kind',
  'IP address (trimmed before send)',
];

export function Settings(): JSX.Element {
  const [authStatus, setAuthStatus] = useState<AuthStatusPayload | null>(null);
  const [bffEndpoint, setBffEndpoint] = useState('https://app.rokibrain.com');
  const [ghToken, setGhToken] = useState('');
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // Telemetry
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [telemetryModalOpen, setTelemetryModalOpen] = useState(false);

  // Load initial state on mount.
  useEffect(() => {
    void (async () => {
      const status = await window.rokibrain.auth.status();
      setAuthStatus(status);
      setBffEndpoint(status.endpoint);

      const token = await window.rokibrain.secrets.get('gh_token');
      if (token) setGhToken(token);

      // Load telemetry preference (default OFF — absent key = false).
      const telVal = await window.rokibrain.secrets.get('telemetry_enabled');
      setTelemetryEnabled(telVal === 'true');
    })();

    const offAuthChange = window.rokibrain.auth.onStatusChange((status) => {
      setAuthStatus(status);
      setIsEnrolling(false);
    });
    return () => offAuthChange();
  }, []);

  const handleEnroll = useCallback(async () => {
    setIsEnrolling(true);
    await window.rokibrain.auth.enroll(bffEndpoint);
  }, [bffEndpoint]);

  const handleLogout = useCallback(async () => {
    await window.rokibrain.auth.logout();
  }, []);

  const handleSaveGhToken = useCallback(async () => {
    setIsSaving(true);
    try {
      if (ghToken.trim()) {
        await window.rokibrain.secrets.set('gh_token', ghToken.trim());
      } else {
        await window.rokibrain.secrets.delete('gh_token');
      }
    } finally {
      setIsSaving(false);
    }
  }, [ghToken]);

  const handleTelemetryToggle = useCallback(async () => {
    const next = !telemetryEnabled;
    setTelemetryEnabled(next);
    if (next) {
      await window.rokibrain.secrets.set('telemetry_enabled', 'true');
    } else {
      await window.rokibrain.secrets.delete('telemetry_enabled');
    }
  }, [telemetryEnabled]);

  const handleOpenSponsor = useCallback(async (url: string) => {
    await window.rokibrain.app.openExternal(url);
  }, []);

  const authStateLabel =
    authStatus?.state === 'enrolled'
      ? 'Enrolled'
      : authStatus?.state === 'enrolling'
        ? 'Enrolling…'
        : authStatus?.state === 'expired'
          ? 'Expired'
          : 'Unenrolled';

  const authStateDot =
    authStatus?.state === 'enrolled'
      ? 'bg-emerald-500'
      : authStatus?.state === 'enrolling'
        ? 'bg-amber-500'
        : 'bg-neutral-500';

  return (
    <div className="h-full w-full overflow-auto bg-neutral-950 p-8">
      <div className="mx-auto max-w-3xl space-y-8">
        {/* Header */}
        <header>
          <h1 className="text-2xl font-semibold text-neutral-100">Settings</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Secrets, connections, and configuration.
          </p>
        </header>

        {/* BFF Enrollment */}
        <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium text-neutral-200">BFF Connection</h2>
            <div className="flex items-center gap-2 text-xs">
              <span className={`inline-block h-2 w-2 rounded-full ${authStateDot}`} />
              <span className="text-neutral-400">{authStateLabel}</span>
            </div>
          </div>

          <div>
            <label htmlFor="bff-endpoint" className="block text-xs text-neutral-400">
              BFF Endpoint
            </label>
            <input
              id="bff-endpoint"
              type="url"
              value={bffEndpoint}
              onChange={(e) => setBffEndpoint(e.target.value)}
              disabled={authStatus?.state === 'enrolled'}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
              placeholder="https://app.rokibrain.com"
            />
          </div>

          {authStatus?.state === 'enrolled' && (
            <div className="space-y-1 text-sm">
              <div className="text-neutral-400">
                Logged in as <span className="text-neutral-200">{authStatus.email}</span>
              </div>
              {authStatus.expiresAt && (
                <div className="text-xs text-neutral-500">
                  Expires {new Date(authStatus.expiresAt).toLocaleDateString()}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            {authStatus?.state !== 'enrolled' ? (
              <button
                type="button"
                onClick={handleEnroll}
                disabled={isEnrolling || !bffEndpoint.trim()}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {isEnrolling ? 'Opening browser…' : 'Enroll Device'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleLogout}
                className="rounded border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 hover:bg-neutral-800"
              >
                Logout
              </button>
            )}
          </div>

          {authStatus?.state === 'expired' && (
            <div className="rounded bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-400">
              Your JWT has expired. Re-enroll to continue.
            </div>
          )}
        </section>

        {/* GitHub Token */}
        <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
          <h2 className="text-base font-medium text-neutral-200">GitHub PAT</h2>
          <p className="text-xs text-neutral-400">
            Personal Access Token for PR queue (M09). Stored encrypted in Keychain.
          </p>

          <div>
            <label htmlFor="gh-token" className="block text-xs text-neutral-400">
              Token (ghp_...)
            </label>
            <input
              id="gh-token"
              type="password"
              value={ghToken}
              onChange={(e) => setGhToken(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-100 placeholder-neutral-500 focus:border-emerald-500 focus:outline-none"
              placeholder="ghp_..."
            />
          </div>

          <button
            type="button"
            onClick={handleSaveGhToken}
            disabled={isSaving}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : 'Save Token'}
          </button>
        </section>

        {/* Hotkeys (read-only for v1) */}
        <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
          <h2 className="text-base font-medium text-neutral-200">Hotkeys</h2>
          <p className="text-xs text-neutral-400">
            Keyboard shortcuts (v1: read-only, v2: customizable).
          </p>

          <div className="space-y-2 text-sm">
            <HotkeyRow label="Cockpit" shortcut="⌘1" />
            <HotkeyRow label="Mesh" shortcut="⌘2" />
            <HotkeyRow label="Drafts" shortcut="⌘3" />
            <HotkeyRow label="Decisions" shortcut="⌘4" />
            <HotkeyRow label="Knowledge" shortcut="⌘5" />
            <HotkeyRow label="Personas" shortcut="⌘6" />
            <HotkeyRow label="PRs" shortcut="⌘7" />
            <HotkeyRow label="Bugs" shortcut="⌘8" />
            <HotkeyRow label="Voice" shortcut="⌘9" />
            <HotkeyRow label="Connections" shortcut="⌘0" />
            <HotkeyRow label="Pause All" shortcut="⌘⇧P" />
            <HotkeyRow label="Voice Toggle" shortcut="⌘⇧V" />
          </div>
        </section>

        {/* Data Export (stub for v1) */}
        <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
          <h2 className="text-base font-medium text-neutral-200">Data Export</h2>
          <p className="text-xs text-neutral-400">
            Export all secrets and configuration (v2 feature).
          </p>
          <button
            type="button"
            disabled
            className="rounded border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-500 opacity-50"
          >
            Export (coming in v2)
          </button>
        </section>

        {/* Support vibeOS */}
        <section className="space-y-3 rounded-lg border border-amber-800/40 bg-amber-900/10 p-5">
          <h2 className="text-base font-medium text-amber-200">Support vibeOS</h2>
          <p className="text-sm text-neutral-400">
            vibeOS is OSS, donation-funded. Your sponsorship covers infra hosting + future v1.1
            features.
          </p>
          <div className="flex flex-wrap gap-2">
            {SPONSOR_LINKS.map(({ label, url }) => (
              <button
                key={url}
                type="button"
                aria-label={`Open ${label}`}
                onClick={() => void handleOpenSponsor(url)}
                className="rounded border border-amber-700/50 bg-amber-900/30 px-4 py-2 text-sm font-medium text-amber-300 hover:bg-amber-800/40 hover:text-amber-100 transition-colors"
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {/* Anonymous crash reports */}
        <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-medium text-neutral-200">Anonymous crash reports</h2>
              <p className="mt-1 text-xs text-neutral-400">
                Help us fix crashes faster. We never send any of your data — only stack traces with
                file:line, app version, OS. Default OFF.
              </p>
            </div>
            {/* Toggle switch */}
            <button
              type="button"
              role="switch"
              aria-checked={telemetryEnabled}
              aria-label="Toggle anonymous crash reports"
              onClick={() => void handleTelemetryToggle()}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                telemetryEnabled ? 'bg-emerald-600' : 'bg-neutral-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                  telemetryEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setTelemetryModalOpen(true)}
            className="text-xs text-neutral-500 underline hover:text-neutral-300"
          >
            What we collect →
          </button>
        </section>
      </div>

      {/* Telemetry detail modal */}
      {telemetryModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Telemetry details"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setTelemetryModalOpen(false)}
        >
          <div
            className="relative mx-4 max-w-md rounded-xl border border-neutral-700 bg-neutral-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-neutral-100">What we collect</h3>
            <ul className="mt-3 space-y-1 text-sm text-neutral-300">
              {TELEMETRY_COLLECT.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-0.5 text-emerald-400">✓</span>
                  {item}
                </li>
              ))}
            </ul>
            <h3 className="mt-4 text-base font-semibold text-neutral-100">We never collect</h3>
            <ul className="mt-3 space-y-1 text-sm text-neutral-300">
              {TELEMETRY_NEVER_COLLECT.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-0.5 text-red-400">✗</span>
                  {item}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setTelemetryModalOpen(false)}
              className="mt-5 w-full rounded bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HotkeyRow({ label, shortcut }: { label: string; shortcut: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-950 px-3 py-2">
      <span className="text-neutral-300">{label}</span>
      <kbd className="rounded bg-neutral-800 px-2 py-1 font-mono text-xs text-neutral-400">
        {shortcut}
      </kbd>
    </div>
  );
}
