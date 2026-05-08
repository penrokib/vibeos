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
// Channel name constants. ALL ipc traffic uses these.
// Naming convention: `rb.<domain>.<verb>` — matches design §1 contract.
// -----------------------------------------------------------------------------

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
  app: {
    quit: () => void;
    /** Build/version metadata for footer + bug reports. */
    version: string;
    platform: NodeJS.Platform;
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    rokibrain: RokibrainBridgeApi;
  }
}
