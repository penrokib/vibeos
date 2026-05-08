// =============================================================================
// rokibrain.app — IPC contracts (M01)
// -----------------------------------------------------------------------------
// Single source of truth for typed IPC channel names + payload shapes between
// main, preload, renderer (and future daemon utilityProcess). Wave-3 module
// agents (M02–M14) extend this file; do NOT redefine channel names elsewhere.
//
// Hard walls (per design §10):
//   - contextBridge only (NEVER nodeIntegration: true). See preload.
//   - Renderer NEVER touches fs / child_process directly. All privileged work
//     goes through one of these channels.
// =============================================================================

/** Health of the daemon utility process (M02 owns it; M01 stubs the contract). */
export type DaemonStatus =
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopped'
  | 'crashed';

export interface DaemonStatusPayload {
  status: DaemonStatus;
  /** ISO 8601 timestamp of last status change. */
  changedAt: string;
  /** Human readable reason for degraded/crashed. */
  reason?: string;
}

/** ws://127.0.0.1:<port> exposed by the daemon for renderer subscriptions. */
export interface DaemonWsPortPayload {
  /** 0 if daemon has not bound yet. */
  port: number;
}

/** Bug severity levels (P0 = critical, P3 = low). */
export type BugSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/** Console log entry captured from renderer. */
export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  ts: number;
}

/** Context metadata auto-captured when a bug is reported. */
export interface BugContext {
  appVersion: string;
  os: string;
  platform: NodeJS.Platform;
  activeTab: TabId;
  url?: string;
  capturedAt: string;
}

/** Screenshot capture result. */
export interface CaptureScreenshotPayload {
  /** PNG data URL from desktopCapturer. */
  dataUrl: string;
}

/** Bug submission input (renderer → main). */
export interface SubmitBugInput {
  title: string;
  description: string;
  severity: BugSeverity;
  /** PNG data URL from screenshot capture. */
  screenshotDataUrl?: string;
  context: BugContext;
  consoleLog?: ConsoleEntry[];
}

/** Bug submission result (main → renderer). */
export interface SubmitBugResult {
  success: boolean;
  bugId?: string;
  error?: string;
}

/** Bug status from BFF. */
export type BugStatus = 'open' | 'in-progress' | 'resolved' | 'closed' | 'duplicate';

/** Past bug item from BFF /bugs list. */
export interface PastBug {
  id: string;
  title: string;
  severity: BugSeverity;
  status: BugStatus;
  createdAt: string;
  resolvedAt?: string;
}

/** Bug list query params. */
export interface ListBugsInput {
  owner?: 'me' | string;
  status?: BugStatus;
  limit?: number;
  offset?: number;
}

/** Bug list result from BFF. */
export interface ListBugsResult {
  bugs: PastBug[];
  total: number;
}

// -----------------------------------------------------------------------------
// M02 — daemon supervisor extensions. Renderer never speaks to the daemon
// directly via IPC; ws://127.0.0.1:<port> is the realtime path. Main is the
// typed-IPC bridge — these payloads cross main ↔ renderer.
// -----------------------------------------------------------------------------

export type ChildLifecycleState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'crashing'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'paused'
  | 'permanently-failed';

export interface ChildStatusSummary {
  id: string;
  platform: string;
  state: ChildLifecycleState;
  restartCount: number;
  recentCrashCount: number;
  changedAt: string;
  lastError?: string;
  nextRestartAt?: string;
}

export interface SupervisorStatusPayload {
  wsPort: number;
  uptime: number;
  emergencyStopped: boolean;
  children: ChildStatusSummary[];
}

export interface DaemonChildRestartRequest {
  childId: string;
}

export interface DaemonEmergencyStopPayload {
  /** Set true → request resume (paired channel re-use to keep IPC surface small). */
  resume?: boolean;
}

/** Tab IDs for the cockpit shell — placeholders rendered in M01, hydrated in M06–M12. */
export type TabId =
  | 'cockpit'
  | 'mesh'
  | 'drafts'
  | 'decisions'
  | 'knowledge'
  | 'personas'
  | 'prs'
  | 'bugs'
  | 'voice'
  | 'connections'
  | 'settings';

export const TAB_IDS: readonly TabId[] = [
  'cockpit',
  'mesh',
  'drafts',
  'decisions',
  'knowledge',
  'personas',
  'prs',
  'bugs',
  'voice',
  'connections',
  'settings',
] as const;

export interface TabSwitchPayload {
  tab: TabId;
  /** True if user-initiated via keyboard shortcut, false if programmatic. */
  viaHotkey: boolean;
}

export interface PauseTogglePayload {
  /** True = paused (mesh sends frozen, voice off, etc.). */
  paused: boolean;
}

export interface VoiceTogglePayload {
  /** True = listening / push-to-talk active. */
  listening: boolean;
}

// -----------------------------------------------------------------------------
// M09: PR queue + gh subprocess
// -----------------------------------------------------------------------------

export interface PrItem {
  number: number;
  title: string;
  url: string;
  author: string;
  repository: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  statusCheckRollup: 'SUCCESS' | 'PENDING' | 'FAILURE' | 'ERROR' | null;
  labels: Array<{ name: string }>;
  isDraft: boolean;
  /** Computed: true if CI green AND (qa-approved label OR foundation-order satisfied). */
  canMerge: boolean;
  /** Computed: reason why merge is blocked, if any. */
  blockReason?: string;
}

export interface PrsListPayload {
  prs: PrItem[];
}

export interface PrsMergeRequest {
  repo: string;
  prNumber: number;
}

export interface PrsMergeResponse {
  success: boolean;
  message: string;
}

export interface PrsOpenShellRequest {
  repo: string;
  prNumber: number;
}

// -----------------------------------------------------------------------------
// M12: Secrets & Auth contracts
// -----------------------------------------------------------------------------

/** Secret keys supported by the secrets store. */
export type SecretKey = 'bff_jwt' | 'gh_token' | 'bff_endpoint' | string;

export interface SecretsGetPayload {
  key: SecretKey;
  /** Value if found, null if not. */
  value: string | null;
}

export interface SecretsSetPayload {
  key: SecretKey;
  value: string;
}

export interface SecretsDeletePayload {
  key: SecretKey;
}

export interface SecretsListPayload {
  /** List of all secret keys stored. */
  keys: string[];
}

/** Auth state for BFF enrollment. */
export type AuthState = 'unenrolled' | 'enrolling' | 'enrolled' | 'expired';

export interface AuthStatusPayload {
  state: AuthState;
  /** User email if enrolled. */
  email?: string;
  /** ISO 8601 timestamp of JWT expiry if enrolled. */
  expiresAt?: string;
  /** BFF endpoint currently configured. */
  endpoint: string;
}

export interface AuthEnrollPayload {
  /** BFF endpoint to enroll against. */
  endpoint: string;
}

// -----------------------------------------------------------------------------
// Mesh — read-only view over the local multi-account WhatsApp backend.
// Wave-3 wires Telegram/Email/LinkedIn children behind the same shape.
// READ ONLY in this slice. Sending stays drafts-only via the Drafts tab.
// -----------------------------------------------------------------------------

/**
 * Canonical platform kinds for supervised children. Added M04.
 * Wave-3 will add 'tg' | 'discord' | 'email' | 'linkedin' as those modules ship.
 */
export type MeshChildKind = 'wa' | 'tg' | 'discord' | 'email' | 'linkedin';

/** Per-account connection status from the local mesh backend. */
export type MeshAccountStatus = 'open' | 'connecting' | 'close' | 'unknown';

export interface MeshAccount {
  /** Local instance name, e.g. wap | was | wab. */
  account: string;
  status: MeshAccountStatus;
}

export interface MeshAccountsPayload {
  accounts: MeshAccount[];
}

export interface MeshChat {
  jid: string;
  name: string;
  /** Unix seconds. */
  last_message_time: number;
  last_message: string;
  unread_count: number;
}

export interface MeshChatsRequest {
  account: string;
  limit?: number;
}

export interface MeshChatsPayload {
  chats: MeshChat[];
}

export interface MeshMessage {
  id: string;
  chat_jid: string;
  sender: string;
  content: string;
  /** Unix seconds. */
  timestamp: number;
  /** 1 if message was sent by the local account, 0 if received. */
  is_from_me: 0 | 1;
  media_type: string;
}

export interface MeshMessagesRequest {
  account: string;
  chatJid: string;
  limit?: number;
}

export interface MeshMessagesPayload {
  messages: MeshMessage[];
}

// -----------------------------------------------------------------------------
// CC Fleet — Claude Code subprocess pool manager.
// API keys NEVER appear in these payloads — read from env at spawn time.
// -----------------------------------------------------------------------------

/** Registered CC account descriptor (mirrors CCAccount from cc-fleet.types). */
export interface CcFleetAccount {
  id: string;
  concurrencyMax: number;
  tokensUsed5h: number;
  lastResetAt: number;
  status: 'idle' | 'busy' | 'rate-limited';
}

/** List payload returned by CC_FLEET_LIST. */
export interface CcFleetListPayload {
  accounts: CcFleetAccount[];
}

/** Job input for CC_FLEET_SUBMIT. */
export interface CcFleetSubmitInput {
  id: string;
  prompt: string;
  account?: string;
  persona?: string;
}

/** Result returned by CC_FLEET_SUBMIT. */
export interface CcFleetSubmitResult {
  jobId: string;
  account: string;
  output: string;
  durationMs: number;
}

// -----------------------------------------------------------------------------
// Cycle 12 — Digest IPC contracts
// DIGEST_GENERATE: renderer → main: trigger CC digest generation.
// DIGEST_LATEST:   renderer → main: request cached digest.
// Main pushes new digests to renderer via `rb.digest.latest` push channel.
// -----------------------------------------------------------------------------

export type DigestItemKind = 'draft' | 'decision' | 'persona' | 'alert';

export interface DigestItemPayload {
  id: string;
  kind: DigestItemKind;
  title: string;
  subtitle?: string;
  deepLink?: string;
  ts: number;
}

export interface DigestPayload {
  id: string;
  generatedAt: number;
  mode: 'work' | 'personal';
  needsYou: DigestItemPayload[];
  whatHappened: DigestItemPayload[];
  stuck: DigestItemPayload[];
}

/** renderer → main: kick off digest generation. */
export interface DigestGenerateInput {
  mode: 'work' | 'personal';
}

/** main → renderer: generation result (or fallback template). */
export interface DigestGenerateResult {
  digest: DigestPayload;
  /** True if CC subprocess was used; false if template fallback. */
  fromCC: boolean;
}

/** renderer → main: request latest cached digest. */
export interface DigestLatestInput {
  mode: 'work' | 'personal';
}

/** main → renderer: latest cached digest, or null if not yet generated. */
export interface DigestLatestResult {
  digest: DigestPayload | null;
}

// IPC channel name constants for the Digest domain.
export const DIGEST_GENERATE = 'rb.digest.generate' as const;
export const DIGEST_LATEST = 'rb.digest.latest' as const;

// -----------------------------------------------------------------------------
// M11: Voice quickbar IPC contracts
// VOICE_RECORD_START   : renderer → main: start audio capture session
// VOICE_RECORD_STOP    : renderer → main: stop capture + transcribe; returns transcript
// VOICE_PUSH_TO_BFF    : renderer → main: POST text to BFF /voice/utterance
// Hardwall §14: audio bytes NEVER leave the renderer as-is; only transcribed text
// crosses IPC. No file paths, no blob references.
// -----------------------------------------------------------------------------

/** Input for starting a voice capture session. */
export interface VoiceRecordStartPayload {
  /** Originating quickbar session ID (renderer-generated UUID). */
  sessionId: string;
}

/** Input to stop recording and transcribe. */
export interface VoiceRecordStopInput {
  /** Same session ID from the start call. */
  sessionId: string;
  /**
   * WebM/Opus audio data captured by MediaRecorder in the renderer.
   * Sent as Uint8Array over IPC (contextBridge serialises to ArrayBuffer).
   * NEVER written to disk — stays in RAM through transcription.
   */
  audioData: Uint8Array;
}

/** Transcript returned by main after whisper.cpp finishes. */
export interface VoiceTranscriptResult {
  text: string;
  durationMs: number;
  /** True when whisper.cpp binary is missing; text contains install instructions. */
  degraded?: boolean;
}

/** Input to push a completed utterance to BFF /voice/utterance. */
export interface VoicePushToBffInput {
  text: string;
  /** ISO 8601 — when the utterance was captured. */
  capturedAt: string;
}

/** Result from BFF push (may fail gracefully). */
export interface VoicePushToBffResult {
  success: boolean;
  taskId?: string;
  error?: string;
}

// -----------------------------------------------------------------------------
// Channel name constants. ALL ipc traffic uses these.
// Naming convention: `rb.<domain>.<verb>` — matches design §1 contract.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// M06a: Cockpit — xterm.js renderer scaffold + echo placeholder IPC
// Cycle 9 wires a real PTY / tmux bridge-mac child. For now, main echoes input.
// -----------------------------------------------------------------------------

/** Identifies a single cockpit pane. */
export interface CockpitPane {
  id: string;
  label: string;
}

/** renderer → main: open a stub pane, returns success. */
export interface CockpitOpenPaneRequest {
  paneId: string;
  cols: number;
  rows: number;
}

export interface CockpitOpenPaneResponse {
  success: boolean;
}

/** renderer → main: keystroke input; main echoes back via COCKPIT_OUTPUT. */
export interface CockpitInputRequest {
  paneId: string;
  data: string;
}

/** main → renderer (push): output stream from pane. */
export interface CockpitOutputPayload {
  paneId: string;
  data: string;
}

/** renderer → main: close a pane. */
export interface CockpitClosePaneRequest {
  paneId: string;
}

/** renderer → main: list panes; v1 returns one stub pane. */
export interface CockpitListPanesResponse {
  panes: CockpitPane[];
}

// -----------------------------------------------------------------------------
// Sponsor & Telemetry (M16 / Cycle-29)
// -----------------------------------------------------------------------------

/** Payload for opening an external HTTPS URL via shell.openExternal. */
export interface OpenExternalPayload {
  /** Must start with https:// — enforced in main. */
  url: string;
}

export const IPC = {
  /** Daemon status broadcasts. main → renderer (push). */
  DAEMON_STATUS: 'rb.daemon.status',
  /** Renderer can request the current ws port. invoke. */
  DAEMON_WS_PORT: 'rb.daemon.wsPort',
  /** Hotkey or click switches active tab. main → renderer + renderer → main. */
  TABS_SWITCH: 'rb.tabs.switch',
  /** Pause-all toggle (⌘⇧P). main → renderer + renderer → main. */
  PAUSE_TOGGLE: 'rb.pause.toggle',
  /** Voice push-to-talk toggle (⌘⇧V). main → renderer + renderer → main. */
  VOICE_TOGGLE: 'rb.voice.toggle',
  /** Quit the app cleanly (Tray menu / cmd-Q). renderer → main. */
  APP_QUIT: 'rb.app.quit',
  /** Full supervisor snapshot. invoke from renderer; main forwards from daemon. */
  DAEMON_SUPERVISOR_STATUS: 'rb.daemon.supervisorStatus',
  /** Request restart (or unlock-then-restart) of a single child. invoke. */
  DAEMON_CHILD_RESTART: 'rb.daemon.childRestart',
  /** Emergency-stop all children (or resume). invoke. */
  DAEMON_EMERGENCY_STOP: 'rb.daemon.emergencyStop',
  /** Push: supervisor status changed (delta or full). main → renderer. */
  DAEMON_SUPERVISOR_BROADCAST: 'rb.daemon.supervisorBroadcast',
  /** M09: List open PRs across both repos. renderer → main. */
  PRS_LIST: 'rb.prs.list',
  /** M09: Merge a PR (gated by qa-approved + CI). renderer → main. */
  PRS_MERGE: 'rb.prs.merge',
  /** M09: Open shell at worktree for manual rebase. renderer → main. */
  PRS_OPEN_SHELL: 'rb.prs.openShell',
  /** Get a secret value by key (M12). renderer → main. */
  SECRETS_GET: 'rb.secrets.get',
  /** Set a secret value by key (M12). renderer → main. */
  SECRETS_SET: 'rb.secrets.set',
  /** Delete a secret by key (M12). renderer → main. */
  SECRETS_DELETE: 'rb.secrets.delete',
  /** List all secret keys (M12). renderer → main. */
  SECRETS_LIST: 'rb.secrets.list',
  /** Start BFF enrollment flow, opens browser (M12). renderer → main. */
  AUTH_ENROLL: 'rb.auth.enroll',
  /** Get current auth state (M12). renderer → main. */
  AUTH_STATUS: 'rb.auth.status',
  /** Logout, wipes secrets (M12). renderer → main. */
  AUTH_LOGOUT: 'rb.auth.logout',
  /** Auth status change broadcast (M12). main → renderer (push). */
  AUTH_STATUS_CHANGE: 'rb.auth.statusChange',
  /** Capture screenshot via desktopCapturer (⌘⇧S). renderer → main. */
  BUGS_CAPTURE: 'rb.bugs.capture',
  /** Submit bug report with screenshot to BFF. renderer → main → BFF. */
  BUGS_SUBMIT: 'rb.bugs.submit',
  /** Fetch past bugs from BFF. renderer → main → BFF. */
  BUGS_LIST: 'rb.bugs.list',
  /** Mesh: list local mesh accounts + connection status. renderer → main. */
  MESH_ACCOUNTS: 'rb.mesh.accounts',
  /** Mesh: list chats for one account. renderer → main. */
  MESH_CHATS: 'rb.mesh.chats',
  /** Mesh: list messages in a chat. renderer → main. */
  MESH_MESSAGES: 'rb.mesh.messages',
  /** M06a: open a cockpit pane stub. renderer → main. */
  COCKPIT_OPEN_PANE: 'rb.cockpit.openPane',
  /** M06a: send keystroke input to a pane. renderer → main. */
  COCKPIT_INPUT: 'rb.cockpit.input',
  /** M06a: output stream from pane. main → renderer (push). */
  COCKPIT_OUTPUT: 'rb.cockpit.output',
  /** M06a: close a cockpit pane. renderer → main. */
  COCKPIT_CLOSE_PANE: 'rb.cockpit.closePane',
  /** M06a: list cockpit panes. renderer → main. */
  COCKPIT_LIST_PANES: 'rb.cockpit.listPanes',
  /** M16: Open an external HTTPS URL (sponsor links, etc.). renderer → main. */
  APP_OPEN_EXTERNAL: 'rb.app.openExternal',
  /** CC Fleet: list registered accounts. renderer → main. */
  CC_FLEET_LIST: 'rb.ccFleet.list',
  /** CC Fleet: submit a job. renderer → main. */
  CC_FLEET_SUBMIT: 'rb.ccFleet.submit',
  /** M11: Voice quickbar — start recording session. renderer → main. */
  VOICE_RECORD_START: 'rb.voice.recordStart',
  /** M11: Voice quickbar — stop recording + transcribe. renderer → main (invoke). */
  VOICE_RECORD_STOP_AND_TRANSCRIBE: 'rb.voice.recordStopAndTranscribe',
  /** M11: Voice quickbar — push transcript to BFF /voice/utterance. renderer → main. */
  VOICE_PUSH_TO_BFF: 'rb.voice.pushToBff',
  /** M11: Voice quickbar — toggle quickbar visibility. renderer → main (invoke). */
  QUICKBAR_TOGGLE: 'rb.quickbar.toggle',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// -----------------------------------------------------------------------------
// API surface exposed on `window.rokibrain` via contextBridge (preload).
// Renderer code imports the type, not the implementation.
// -----------------------------------------------------------------------------

export interface RokibrainBridgeApi {
  daemon: {
    /** Subscribe to status broadcasts; returns an unsubscribe function. */
    onStatus: (handler: (payload: DaemonStatusPayload) => void) => () => void;
    /** One-shot fetch of the current ws port. */
    getWsPort: () => Promise<DaemonWsPortPayload>;
    /** M02: Full supervisor snapshot — children + uptime. */
    getSupervisorStatus: () => Promise<SupervisorStatusPayload>;
    /** M02: Subscribe to supervisor status pushes. */
    onSupervisorStatus: (handler: (payload: SupervisorStatusPayload) => void) => () => void;
    /** M02: Restart (or unlock-then-restart) a child by id. */
    restartChild: (req: DaemonChildRestartRequest) => Promise<void>;
    /** M02: Emergency-stop all children (or resume). */
    emergencyStop: (payload?: DaemonEmergencyStopPayload) => Promise<void>;
  };
  tabs: {
    /** Programmatic tab switch (renderer-initiated). */
    switch: (tab: TabId) => Promise<void>;
    /** Subscribe to tab-switch broadcasts (e.g. from hotkeys). */
    onSwitch: (handler: (payload: TabSwitchPayload) => void) => () => void;
  };
  pause: {
    toggle: () => Promise<PauseTogglePayload>;
    onToggle: (handler: (payload: PauseTogglePayload) => void) => () => void;
  };
  voice: {
    toggle: () => Promise<VoiceTogglePayload>;
    onToggle: (handler: (payload: VoiceTogglePayload) => void) => () => void;
  };
  prs: {
    /** M09: List open PRs across both repos. */
    list: () => Promise<PrsListPayload>;
    /** M09: Merge a PR (gated by qa-approved + CI). */
    merge: (req: PrsMergeRequest) => Promise<PrsMergeResponse>;
    /** M09: Open shell at worktree for manual rebase. */
    openShell: (req: PrsOpenShellRequest) => Promise<void>;
  };
  secrets: {
    /** Get a secret value by key. Returns null if not found. */
    get: (key: SecretKey) => Promise<string | null>;
    /** Set a secret value. Encrypted at rest. */
    set: (key: SecretKey, value: string) => Promise<void>;
    /** Delete a secret by key. */
    delete: (key: SecretKey) => Promise<void>;
    /** List all secret keys. */
    list: () => Promise<string[]>;
  };
  auth: {
    /** Get current auth status. */
    status: () => Promise<AuthStatusPayload>;
    /** Start BFF enrollment flow (opens browser). */
    enroll: (endpoint: string) => Promise<void>;
    /** Logout and wipe secrets. */
    logout: () => Promise<void>;
    /** Subscribe to auth status changes. */
    onStatusChange: (handler: (payload: AuthStatusPayload) => void) => () => void;
  };
  bugs: {
    /** Capture screenshot via desktopCapturer. */
    capture: () => Promise<CaptureScreenshotPayload>;
    /** Submit bug to BFF /bugs endpoint. */
    submit: (input: SubmitBugInput) => Promise<SubmitBugResult>;
    /** List past bugs from BFF. */
    list: (input: ListBugsInput) => Promise<ListBugsResult>;
  };
  mesh: {
    /** List local mesh accounts + connection status. */
    accounts: () => Promise<MeshAccountsPayload>;
    /** List chats for one account. */
    chats: (req: MeshChatsRequest) => Promise<MeshChatsPayload>;
    /** List messages in a chat (newest first). */
    messages: (req: MeshMessagesRequest) => Promise<MeshMessagesPayload>;
  };
  cockpit: {
    /** M06a: open a stub pane (real PTY wired in cycle 9). */
    openPane: (req: CockpitOpenPaneRequest) => Promise<CockpitOpenPaneResponse>;
    /** M06a: send keystroke data to pane; main echoes it back for v1. */
    input: (req: CockpitInputRequest) => Promise<void>;
    /** M06a: close a pane stub. */
    closePane: (req: CockpitClosePaneRequest) => Promise<void>;
    /** M06a: list panes; v1 returns the single echo stub. */
    listPanes: () => Promise<CockpitListPanesResponse>;
    /** M06a: subscribe to output pushed from main; returns unsubscribe fn. */
    onOutput: (handler: (payload: CockpitOutputPayload) => void) => () => void;
  };
  ccFleet: {
    /** List all registered CC accounts and their status. */
    list: () => Promise<CcFleetListPayload>;
    /** Submit a job to the CC fleet; resolves when the subprocess completes. */
    submit: (input: CcFleetSubmitInput) => Promise<CcFleetSubmitResult>;
  };
  quickbar: {
    /** M11: Toggle quickbar window visibility (Alt+Space handler). */
    toggle: () => Promise<void>;
    /** M11: Start recording in voice child. */
    recordStart: (payload: VoiceRecordStartPayload) => Promise<void>;
    /** M11: Stop recording + transcribe via whisper.cpp. Returns transcript. */
    recordStopAndTranscribe: (input: VoiceRecordStopInput) => Promise<VoiceTranscriptResult>;
    /** M11: Push finalized utterance text to BFF /voice/utterance. */
    pushToBff: (input: VoicePushToBffInput) => Promise<VoicePushToBffResult>;
  };
  digest: {
    /**
     * M12/Cycle-12: Trigger digest generation for the given mode.
     * Renderer → Main; main dispatches to DigestGenerator via FleetManager.
     * Result is pushed back via onLatest subscription.
     *
     * IPC channel: DIGEST_GENERATE
     */
    generate: (input: DigestGenerateInput) => Promise<DigestGenerateResult>;
    /**
     * Request the latest cached digest for a given mode.
     * Returns null if none has been generated yet.
     *
     * IPC channel: DIGEST_LATEST
     */
    getLatest: (input: DigestLatestInput) => Promise<DigestLatestResult>;
    /**
     * Subscribe to new digests pushed from main when generation completes.
     * Returns an unsubscribe function (call on component unmount).
     */
    onLatest: (handler: (payload: DigestLatestResult) => void) => () => void;
  };
  app: {
    quit: () => void;
    /** Build/version metadata for footer + bug reports. */
    version: string;
    platform: NodeJS.Platform;
    /**
     * Open an HTTPS URL in the system default browser.
     * Rejects if URL is not https:// (defense against javascript: URIs).
     */
    openExternal: (url: string) => Promise<void>;
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    rokibrain: RokibrainBridgeApi;
  }
}
