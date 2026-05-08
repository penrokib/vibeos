// =============================================================================
// rokibrain.app — Connections Tab (cycle 14 + 15)
// -----------------------------------------------------------------------------
// Shows each daemon-supervised child (wa / tg / discord / email / linkedin)
// with its live status + a restart button.  "+ Add account" opens a wizard:
//   - Telegram: 3-step pair wizard (phone → SMS code → done) [Cycle 14]
//   - Email: Gmail OAuth or manual IMAP/SMTP wizard [Cycle 15]
//   - Other platforms: stub (future cycles)
//
// Hard walls:
//   - Renderer accesses daemon ONLY via window.rokibrain.daemon.* (contextBridge).
//   - Email creds transit IPC to main; NEVER stored in renderer state beyond
//     the transient wizard form (cleared on close).
//   - TG pair IPC: TG_PAIR_START → main, TG_PAIR_QR ← main, TG_PAIR_CONFIRM → main.
//   - All IPC channels live in ipc-contracts.ts + main (never inlined here).
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChildLifecycleState,
  ChildStatusSummary,
  MeshChildKind,
  SupervisorStatusPayload,
  TgPairResultPayload,
} from '../../shared/ipc-contracts';
import {
  TG_PAIR_START,
  TG_PAIR_QR,
  TG_PAIR_CONFIRM,
  TG_PAIR_RESULT,
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

// ---- email wizard -----------------------------------------------------------

type EmailWizardStep =
  | 'choose-method'   // Step 1: Gmail or Other IMAP
  | 'gmail-oauth'     // Step 2a: Gmail OAuth instructions
  | 'imap-form'       // Step 2b: manual IMAP/SMTP form
  | 'testing'         // Step 3: testing connection
  | 'success'         // Step 4: paired
  | 'error';          // Step 4: error

interface ImapFormState {
  account: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  user: string;
  pass: string;
}

const IMAP_FORM_DEFAULTS: ImapFormState = {
  account: '',
  imapHost: '',
  imapPort: '993',
  smtpHost: '',
  smtpPort: '587',
  user: '',
  pass: '',
};

function EmailWizard({ onPaired }: {
  onClose: () => void;
  onPaired: () => void;
}): JSX.Element {
  const [step, setStep] = useState<EmailWizardStep>('choose-method');
  const [form, setForm] = useState<ImapFormState>(IMAP_FORM_DEFAULTS);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleImapSubmit = useCallback(async () => {
    setStep('testing');
    setErrorMsg(null);
    try {
      // Send creds to main via IPC. Main stores in M12 Keychain + tests IMAP.
      // Channel rb.email.pairImap is declared in ipc-contracts.ts (Cycle 15).
      const result = await (window as unknown as {
        rokibrain: {
          email?: {
            pairImap: (input: {
              account: string;
              imapHost: string;
              imapPort: number;
              smtpHost: string;
              smtpPort: number;
              user: string;
              pass: string;
            }) => Promise<{ success: boolean; error?: string }>;
          };
        };
      }).rokibrain.email?.pairImap({
        account: form.account || `imap-${form.user}`,
        imapHost: form.imapHost,
        imapPort: Number(form.imapPort) || 993,
        smtpHost: form.smtpHost,
        smtpPort: Number(form.smtpPort) || 587,
        user: form.user,
        pass: form.pass,
      });

      if (result?.success) {
        // Clear sensitive form fields immediately
        setForm(IMAP_FORM_DEFAULTS);
        setStep('success');
        setTimeout(onPaired, 1500);
      } else {
        setErrorMsg(result?.error ?? 'Connection test failed');
        setStep('error');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setStep('error');
    }
  }, [form, onPaired]);

  const handleGmailOAuthOpen = useCallback(() => {
    // Main process handles OAuth browser flow. Renderer opens instructions.
    // In a real implementation, main would call shell.openExternal(oauthUrl)
    // and a deep-link callback would return the tokens.
    // For now: display instructions + notify the IPC flow is pending.
    void (window as unknown as {
      rokibrain: { email?: { pairStart: (i: { account: string }) => Promise<void> } };
    }).rokibrain.email?.pairStart({ account: 'gmail-default' });
  }, []);

  if (step === 'choose-method') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-neutral-500">Choose how to connect your email.</p>
        <button
          type="button"
          onClick={() => { setStep('gmail-oauth'); }}
          className="flex w-full items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-left hover:border-emerald-700/50 hover:bg-neutral-800/70"
        >
          <span className="text-xl" aria-hidden="true">G</span>
          <div>
            <div className="text-sm text-neutral-200">Gmail (OAuth)</div>
            <div className="text-xs text-neutral-500">Recommended — no password stored</div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => { setStep('imap-form'); }}
          className="flex w-full items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-left hover:border-emerald-700/50 hover:bg-neutral-800/70"
        >
          <span className="text-xl" aria-hidden="true">✉️</span>
          <div>
            <div className="text-sm text-neutral-200">Other IMAP / SMTP</div>
            <div className="text-xs text-neutral-500">Outlook, Fastmail, iCloud, custom server</div>
          </div>
        </button>
      </div>
    );
  }

  if (step === 'gmail-oauth') {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-3 text-xs text-amber-300">
          <p className="font-medium">Gmail OAuth — after merge</p>
          <p className="mt-1 text-amber-400/80">
            Post-merge Roki provides OAuth credentials in the Connections tab.
            The OAuth flow opens a browser window; the refresh token is stored
            encrypted in the macOS Keychain (M12). No password is ever stored.
          </p>
        </div>
        <p className="text-xs text-neutral-500">
          Steps: Settings → Connections → + Add account → Email → Gmail (OAuth)
          → sign in → allow access → vibeOS stores token securely.
        </p>
        <button
          type="button"
          onClick={handleGmailOAuthOpen}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
        >
          Open Gmail OAuth flow (post-merge)
        </button>
        <button
          type="button"
          onClick={() => { setStep('choose-method'); }}
          className="rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700"
        >
          ← Back
        </button>
      </div>
    );
  }

  if (step === 'imap-form') {
    const field = (label: string, key: keyof ImapFormState, type = 'text', placeholder = ''): JSX.Element => (
      <div>
        <label className="mb-1 block text-xs text-neutral-400">{label}</label>
        <input
          type={type}
          value={form[key]}
          placeholder={placeholder}
          autoComplete={type === 'password' ? 'new-password' : 'off'}
          onChange={(e) => { setForm((prev) => ({ ...prev, [key]: e.target.value })); }}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-white placeholder-neutral-600 focus:border-emerald-600 focus:outline-none"
        />
      </div>
    );

    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-neutral-500">Enter your IMAP and SMTP settings.</p>
        {field('Account label', 'account', 'text', 'e.g. work-outlook')}
        <div className="flex gap-2">
          {field('IMAP host', 'imapHost', 'text', 'imap.example.com')}
          {field('Port', 'imapPort', 'text', '993')}
        </div>
        <div className="flex gap-2">
          {field('SMTP host', 'smtpHost', 'text', 'smtp.example.com')}
          {field('Port', 'smtpPort', 'text', '587')}
        </div>
        {field('Email / username', 'user', 'text', 'you@example.com')}
        {field('Password / app password', 'pass', 'password')}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => { setStep('choose-method'); }}
            className="flex-1 rounded-md bg-neutral-800 py-2 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={() => { void handleImapSubmit(); }}
            disabled={!form.imapHost || !form.smtpHost || !form.user || !form.pass}
            className="flex-1 rounded-md bg-emerald-700 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Test &amp; save
          </button>
        </div>
      </div>
    );
  }

  if (step === 'testing') {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <div className="h-1 w-48 overflow-hidden rounded-full bg-neutral-800">
          <div className="h-full w-1/2 animate-pulse bg-emerald-500" />
        </div>
        <p className="text-xs text-neutral-400">Testing connection…</p>
      </div>
    );
  }

  if (step === 'success') {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <span className="text-3xl" aria-hidden="true">✅</span>
        <p className="text-sm font-medium text-emerald-300">Email connected</p>
        <p className="text-xs text-neutral-500">Credentials stored securely in Keychain.</p>
      </div>
    );
  }

  // error
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-3 text-xs text-red-300">
        {errorMsg ?? 'Connection failed — check your settings and try again.'}
      </div>
      <button
        type="button"
        onClick={() => { setStep('imap-form'); setErrorMsg(null); }}
        className="rounded-md bg-neutral-800 py-2 text-sm text-neutral-300 hover:bg-neutral-700"
      >
        ← Try again
      </button>
    </div>
  );
}

// ---- Telegram pair wizard (Cycle 14) ----------------------------------------

type TgWizardStep = 'phone' | 'code' | 'done' | 'error';

function TelegramPairWizard({
  onClose,
  onBack,
}: {
  onClose: () => void;
  onBack: () => void;
}): JSX.Element {
  const [step, setStep] = useState<TgWizardStep>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const accountRef = useRef('personal');

  useEffect(() => {
    const ipc = (window as unknown as { rokibrain?: {
      _on?: (channel: string, handler: (payload: unknown) => void) => () => void
    } }).rokibrain;
    if (!ipc?._on) return;
    const offQr = ipc._on(TG_PAIR_QR, () => { setStep('code'); });
    const offResult = ipc._on(TG_PAIR_RESULT, (payload: unknown) => {
      const p = payload as TgPairResultPayload;
      if (p.success) { setStep('done'); }
      else { setErrorMsg(p.error ?? 'Pair failed'); setStep('error'); }
    });
    return () => { offQr(); offResult(); };
  }, []);

  const handlePhoneSubmit = async (): Promise<void> => {
    if (!phone.trim()) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const ipc = (window as unknown as { rokibrain?: {
        _invoke?: (channel: string, payload: unknown) => Promise<unknown>
      } }).rokibrain;
      if (ipc?._invoke) {
        await ipc._invoke(TG_PAIR_START, { account: accountRef.current, phoneNumber: phone.trim() });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start pair');
      setStep('error');
    } finally {
      setBusy(false);
    }
  };

  const handleCodeSubmit = async (): Promise<void> => {
    if (!code.trim()) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const ipc = (window as unknown as { rokibrain?: {
        _invoke?: (channel: string, payload: unknown) => Promise<unknown>
      } }).rokibrain;
      if (ipc?._invoke) {
        await ipc._invoke(TG_PAIR_CONFIRM, { account: accountRef.current, code: code.trim() });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Code submission failed');
      setStep('error');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'done') {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <span className="text-4xl" aria-hidden="true">✅</span>
        <p className="text-sm font-medium text-emerald-400">Telegram connected!</p>
        <p className="text-xs text-neutral-500">
          Set <span className="font-mono text-emerald-400">MESH_TG_ENABLED=true</span>{' '}
          and restart the daemon to activate.
        </p>
        <button type="button" onClick={onClose}
          className="mt-2 rounded-md bg-emerald-700 px-4 py-2 text-sm text-white hover:bg-emerald-600">
          Done
        </button>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <span className="text-4xl" aria-hidden="true">⚠️</span>
        <p className="text-sm font-medium text-red-400">Pair failed</p>
        <p className="text-xs text-red-300">{errorMsg}</p>
        <button type="button" onClick={() => { setStep('phone'); setCode(''); setErrorMsg(''); }}
          className="mt-2 rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700">
          Try again
        </button>
        <button type="button" onClick={onBack} className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Back
        </button>
      </div>
    );
  }

  if (step === 'code') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-xs text-neutral-500">
          Enter the code Telegram sent to <span className="font-medium text-white">{phone}</span>.
        </p>
        <input type="text" inputMode="numeric" placeholder="12345" value={code}
          onChange={(e) => setCode(e.target.value)} maxLength={10}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-emerald-600 focus:outline-none" />
        <button type="button" disabled={busy || !code.trim()} onClick={() => void handleCodeSubmit()}
          className="w-full rounded-md bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? 'Verifying…' : 'Confirm code'}
        </button>
        <button type="button" onClick={onBack} className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-neutral-500">
        Enter your Telegram phone number in E.164 format (e.g. +601234567890).
      </p>
      <input type="tel" placeholder="+601234567890" value={phone}
        onChange={(e) => setPhone(e.target.value)}
        className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-emerald-600 focus:outline-none" />
      <button type="button" disabled={busy || !phone.trim()} onClick={() => void handlePhoneSubmit()}
        className="w-full rounded-md bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? 'Sending code…' : 'Send code'}
      </button>
      <button type="button" onClick={onBack} className="text-xs text-neutral-500 hover:text-neutral-300">
        ← Back to platform list
      </button>
    </div>
  );
}

// ---- add-account modal ------------------------------------------------------

function AddAccountModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [selected, setSelected] = useState<MeshChildKind | null>(null);
  const [emailPaired, setEmailPaired] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Add account"
    >
      <div className="w-[26rem] rounded-xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">
            {selected === 'tg' ? 'Connect Telegram' : selected === 'email' ? 'Connect email' : 'Add account'}
          </h2>
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
        ) : selected === 'tg' ? (
          // Telegram: real pair wizard (Cycle 14)
          <TelegramPairWizard
            onClose={onClose}
            onBack={() => setSelected(null)}
          />
        ) : selected === 'email' && !emailPaired ? (
          <EmailWizard
            onClose={onClose}
            onPaired={() => { setEmailPaired(true); }}
          />
        ) : selected === 'email' && emailPaired ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="text-3xl" aria-hidden="true">✅</span>
            <p className="text-sm font-medium text-emerald-300">Email paired successfully</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <span className="text-4xl" aria-hidden="true">
              {platformIcon(selected)}
            </span>
            <p className="text-sm font-medium text-neutral-200">
              {platformLabel(selected)} pair flow
            </p>
            <p className="text-xs text-neutral-500">
              Pair flow coming in a future cycle.
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
