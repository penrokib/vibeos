// =============================================================================
// rokibrain.app — main process (M01 + M02)
// -----------------------------------------------------------------------------
// Owns: window lifecycle, tray, global hotkeys, IPC routing, autoupdater stub,
// **daemon utilityProcess lifecycle** (M02 added).
//
// M02 changes:
//   - Spawns the daemon as an Electron `utilityProcess` (NOT child_process.fork)
//     on `app.whenReady`; tears it down on `before-quit`.
//   - Bridges renderer IPC ↔ daemon parentPort messages.
//
// Hardwalls preserved:
//   - nodeIntegration: false, contextIsolation: true, sandbox: true.
//   - Renderer never imports node fs/child_process.
//   - Daemon work runs in a separate process — Electron main never blocks on it.
// =============================================================================

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IPC,
  TAB_IDS,
  type AuthEnrollPayload,
  type AuthStatusPayload,
  type CaptureScreenshotPayload,
  type DaemonChildRestartRequest,
  type DaemonEmergencyStopPayload,
  type DaemonStatusPayload,
  type DaemonWsPortPayload,
  type ListBugsInput,
  type ListBugsResult,
  type MeshAccount,
  type MeshAccountStatus,
  type MeshAccountsPayload,
  type MeshChat,
  type MeshChatsPayload,
  type MeshChatsRequest,
  type MeshMessage,
  type MeshMessagesPayload,
  type MeshMessagesRequest,
  type PauseTogglePayload,
  type PrItem,
  type PrsListPayload,
  type PrsMergeRequest,
  type PrsMergeResponse,
  type PrsOpenShellRequest,
  type SecretKey,
  type SecretsGetPayload,
  type SecretsListPayload,
  type SecretsSetPayload,
  type SubmitBugInput,
  type SubmitBugResult,
  type SupervisorStatusPayload,
  type TabId,
  type TabSwitchPayload,
  type VoiceTogglePayload,
} from '../shared/ipc-contracts';
import type {
  SupervisorInboundMessage,
  SupervisorOutboundMessage,
} from '../daemon';
import {
  getAuthStatus,
  handleEnrollDeepLink,
  initAuth,
  logout,
  setAuthBroadcast,
  startEnrollment,
} from './auth';
import * as gh from './gh';
import { captureScreenshot } from './screenshot';
import { deleteSecret, getSecret, listSecrets, setSecret } from './secrets';

// ---- module state ----------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let paused = false;
let voiceListening = false;
let daemonProcess: UtilityProcess | null = null;
let daemonReady = false;
let daemonStatus: DaemonStatusPayload = {
  status: 'stopped',
  changedAt: new Date().toISOString(),
  reason: 'awaiting daemon utilityProcess fork',
};
let supervisorStatus: SupervisorStatusPayload = {
  wsPort: 0,
  uptime: 0,
  emergencyStopped: false,
  children: [],
};

// pending request bookkeeping for daemon-IPC round-trips
let pendingStatusResolvers: Array<(s: SupervisorStatusPayload) => void> = [];
let pendingWsPortResolvers: Array<(p: DaemonWsPortPayload) => void> = [];

// ---- autoupdater stub (M13 wires real signing) -----------------------------

function configureAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://app.rokibrain.com/releases/desktop/',
  });
  autoUpdater.on('error', (err) => {
    console.warn('[autoupdater] error (expected in dev):', err.message);
  });
}

// ---- window ----------------------------------------------------------------

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function showOrCreateWindow(): void {
  if (!mainWindow) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// ---- tray ------------------------------------------------------------------

function createTray(): void {
  const greenDot =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR4nGNgGAVUBowMDAz/' +
    'GfBoYsKnEZsmJgYsGpgYGBgYGRkZGfBpYsCnCRcgRhMTLk2EAAB7yQQBnjXJpAAAAABJRU5E' +
    'rkJggg==';
  const icon = nativeImage.createFromBuffer(Buffer.from(greenDot, 'base64'));
  if (!icon.isEmpty() && process.platform === 'darwin') {
    icon.setTemplateImage(false);
  }

  tray = new Tray(icon);
  tray.setToolTip('rokibrain');
  const menu = Menu.buildFromTemplate([
    { label: 'Show rokibrain', click: () => showOrCreateWindow() },
    { type: 'separator' },
    { label: 'Pause all', type: 'checkbox', checked: paused, click: () => togglePause() },
    { label: 'Voice', type: 'checkbox', checked: voiceListening, click: () => toggleVoice() },
    { type: 'separator' },
    { label: 'Quit rokibrain', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      showOrCreateWindow();
    }
  });
}

// ---- bugs submission (M10) -------------------------------------------------

/**
 * Submits a bug report to BFF /bugs endpoint via multipart POST.
 * Uses JWT auth (same as M07). For now, returns stub until BFF endpoint exists.
 */
async function submitBug(input: SubmitBugInput): Promise<SubmitBugResult> {
  try {
    // TODO M07: Get JWT from safeStorage (M12 wires this).
    // For now, stub the BFF call since /bugs endpoint doesn't exist yet.
    console.log('[bugs] submit:', {
      title: input.title,
      severity: input.severity,
      hasScreenshot: !!input.screenshotDataUrl,
      context: input.context,
    });

    // Stub: simulate successful submission.
    // Real implementation will POST to https://app.rokibrain.com/bugs
    // with JWT bearer token and multipart form data.
    const bugId = `bug_${Date.now()}`;
    return { success: true, bugId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[bugs] submit failed:', msg);
    return { success: false, error: msg };
  }
}

/**
 * Fetches past bugs from BFF /bugs endpoint.
 * For now, returns stub until BFF endpoint exists.
 */
async function listBugs(input: ListBugsInput): Promise<ListBugsResult> {
  try {
    // TODO M07: Get JWT from safeStorage (M12 wires this).
    // For now, stub the BFF call.
    console.log('[bugs] list:', input);

    // Stub: return empty list.
    // Real implementation will GET https://app.rokibrain.com/bugs?owner=me&status=...
    return { bugs: [], total: 0 };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[bugs] list failed:', msg);
    throw new Error(msg);
  }
}

// ---- IPC routing -----------------------------------------------------------

function broadcast<T>(channel: string, payload: T): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function switchTab(tab: TabId, viaHotkey: boolean): void {
  const payload: TabSwitchPayload = { tab, viaHotkey };
  broadcast(IPC.TABS_SWITCH, payload);
}

function togglePause(): PauseTogglePayload {
  paused = !paused;
  const payload: PauseTogglePayload = { paused };
  broadcast(IPC.PAUSE_TOGGLE, payload);
  // ⌘⇧P → emergency stop / resume.
  if (paused) {
    sendDaemon({ kind: 'emergencyStop' });
  } else {
    sendDaemon({ kind: 'resume' });
  }
  return payload;
}

function toggleVoice(): VoiceTogglePayload {
  voiceListening = !voiceListening;
  const payload: VoiceTogglePayload = { listening: voiceListening };
  broadcast(IPC.VOICE_TOGGLE, payload);
  return payload;
}

async function loadPrSequence(): Promise<number[]> {
  try {
    const path = join(__dirname, '../../../../state/pr-sequence.json');
    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content) as { sequence: number[] };
    return parsed.sequence ?? [];
  } catch {
    return []; // File doesn't exist or invalid — no foundation-order enforcement
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.DAEMON_WS_PORT, async (): Promise<DaemonWsPortPayload> => {
    if (!daemonProcess || !daemonReady) return { port: 0 };
    return new Promise<DaemonWsPortPayload>((resolve) => {
      pendingWsPortResolvers.push(resolve);
      sendDaemon({ kind: 'getWsPort' });
      // safety timeout — never let renderer hang
      setTimeout(() => {
        const idx = pendingWsPortResolvers.indexOf(resolve);
        if (idx >= 0) {
          pendingWsPortResolvers.splice(idx, 1);
          resolve({ port: 0 });
        }
      }, 2_000);
    });
  });

  ipcMain.handle(IPC.DAEMON_SUPERVISOR_STATUS, async (): Promise<SupervisorStatusPayload> => {
    if (!daemonProcess || !daemonReady) return supervisorStatus;
    return new Promise<SupervisorStatusPayload>((resolve) => {
      pendingStatusResolvers.push(resolve);
      sendDaemon({ kind: 'getStatus' });
      setTimeout(() => {
        const idx = pendingStatusResolvers.indexOf(resolve);
        if (idx >= 0) {
          pendingStatusResolvers.splice(idx, 1);
          resolve(supervisorStatus);
        }
      }, 2_000);
    });
  });

  ipcMain.handle(
    IPC.DAEMON_CHILD_RESTART,
    async (_evt, req: DaemonChildRestartRequest) => {
      if (!req?.childId) throw new Error('childId required');
      sendDaemon({ kind: 'unlock', childId: req.childId });
    },
  );

  ipcMain.handle(
    IPC.DAEMON_EMERGENCY_STOP,
    async (_evt, payload?: DaemonEmergencyStopPayload) => {
      if (payload?.resume) {
        sendDaemon({ kind: 'resume' });
        if (paused) togglePause(); // realign pause flag w/ supervisor
      } else {
        sendDaemon({ kind: 'emergencyStop' });
        if (!paused) {
          paused = true;
          broadcast(IPC.PAUSE_TOGGLE, { paused } satisfies PauseTogglePayload);
        }
      }
    },
  );

  ipcMain.handle(IPC.TABS_SWITCH, (_evt, tab: TabId) => {
    if (!TAB_IDS.includes(tab)) throw new Error(`unknown tab: ${tab}`);
    switchTab(tab, false);
  });
  ipcMain.handle(IPC.PAUSE_TOGGLE, () => togglePause());
  ipcMain.handle(IPC.VOICE_TOGGLE, () => toggleVoice());
  ipcMain.on(IPC.APP_QUIT, () => app.quit());

  // M09: PR queue + gh subprocess
  ipcMain.handle(IPC.PRS_LIST, async (): Promise<PrsListPayload> => {
    const rawPrs = await gh.listOpenPrs({
      onStdout: (data) => console.log('[gh stdout]', data),
      onStderr: (data) => console.warn('[gh stderr]', data),
    });

    const sequence = await loadPrSequence();

    const prs: PrItem[] = rawPrs.map((pr) => {
      // Compute canMerge + blockReason
      let canMerge = false;
      let blockReason: string | undefined;

      if (pr.isDraft) {
        blockReason = 'Draft PR';
      } else if (pr.mergeable === 'CONFLICTING') {
        blockReason = 'Merge conflict (rebase needed)';
      } else if (pr.statusCheckRollup !== 'SUCCESS') {
        blockReason = 'CI not green';
      } else {
        const hasQaApproved = pr.labels.some((l) => l.name === 'qa-approved');
        const inFoundationOrder = sequence.length === 0 || sequence.includes(pr.number);

        if (hasQaApproved || inFoundationOrder) {
          canMerge = true;
        } else {
          blockReason = 'Missing qa-approved label and not in foundation-order';
        }
      }

      return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        repository: pr.repository,
        mergeable: pr.mergeable,
        statusCheckRollup: pr.statusCheckRollup,
        labels: pr.labels,
        isDraft: pr.isDraft,
        canMerge,
        blockReason,
      };
    });

    return { prs };
  });

  ipcMain.handle(
    IPC.PRS_MERGE,
    async (_evt, req: PrsMergeRequest): Promise<PrsMergeResponse> => {
      // Re-fetch to confirm gates haven't changed (TOCTOU safety)
      const pr = await gh.viewPr(req.repo, req.prNumber);
      if (!pr) {
        return { success: false, message: 'PR not found' };
      }

      const sequence = await loadPrSequence();
      const hasQaApproved = pr.labels.some((l) => l.name === 'qa-approved');
      const inFoundationOrder = sequence.length === 0 || sequence.includes(pr.number);

      if (pr.isDraft) {
        return { success: false, message: 'Cannot merge draft PR' };
      }
      if (pr.mergeable === 'CONFLICTING') {
        return { success: false, message: 'Merge conflict — rebase required' };
      }
      if (pr.statusCheckRollup !== 'SUCCESS') {
        return { success: false, message: 'CI checks not passing' };
      }
      if (!hasQaApproved && !inFoundationOrder) {
        return {
          success: false,
          message: 'Missing qa-approved label and not in foundation-order',
        };
      }

      // All gates passed — merge
      return gh.mergePr(req.repo, req.prNumber, {
        onStdout: (data) => console.log('[gh merge stdout]', data),
        onStderr: (data) => console.warn('[gh merge stderr]', data),
      });
    }
  );

  ipcMain.handle(IPC.PRS_OPEN_SHELL, async (_evt, req: PrsOpenShellRequest): Promise<void> => {
    await gh.openShellAtWorktree(req.repo, req.prNumber);
  });

  // M12: Secrets handlers
  ipcMain.handle(IPC.SECRETS_GET, async (_evt, key: SecretKey): Promise<SecretsGetPayload> => {
    const value = await getSecret(key);
    return { key, value };
  });
  ipcMain.handle(IPC.SECRETS_SET, async (_evt, payload: SecretsSetPayload): Promise<void> => {
    await setSecret(payload.key, payload.value);
  });
  ipcMain.handle(IPC.SECRETS_DELETE, async (_evt, key: SecretKey): Promise<void> => {
    await deleteSecret(key);
  });
  ipcMain.handle(IPC.SECRETS_LIST, async (): Promise<SecretsListPayload> => {
    const keys = await listSecrets();
    return { keys };
  });

  // M12: Auth handlers
  ipcMain.handle(IPC.AUTH_STATUS, (): AuthStatusPayload => getAuthStatus());
  ipcMain.handle(IPC.AUTH_ENROLL, async (_evt, payload: AuthEnrollPayload): Promise<void> => {
    await startEnrollment(payload.endpoint);
  });
  ipcMain.handle(IPC.AUTH_LOGOUT, async (): Promise<void> => {
    await logout();
  });

  // M10: bugs handlers
  ipcMain.handle(IPC.BUGS_CAPTURE, async (): Promise<CaptureScreenshotPayload> => {
    return captureScreenshot();
  });
  ipcMain.handle(IPC.BUGS_SUBMIT, async (_evt, input: SubmitBugInput): Promise<SubmitBugResult> => {
    return submitBug(input);
  });
  ipcMain.handle(IPC.BUGS_LIST, async (_evt, input: ListBugsInput): Promise<ListBugsResult> => {
    return listBugs(input);
  });

  // Mesh — read-only over the local multi-account WhatsApp backend.
  // Sending stays drafts-only; no MESH_SEND channel exposed.
  ipcMain.handle(IPC.MESH_ACCOUNTS, (): Promise<MeshAccountsPayload> => fetchMeshAccounts());
  ipcMain.handle(IPC.MESH_CHATS, (_evt, req: MeshChatsRequest): Promise<MeshChatsPayload> =>
    fetchMeshChats(req),
  );
  ipcMain.handle(
    IPC.MESH_MESSAGES,
    (_evt, req: MeshMessagesRequest): Promise<MeshMessagesPayload> => fetchMeshMessages(req),
  );
}

// ---- mesh backend client ---------------------------------------------------
// Talks to the local wa-multi-server (or future unified mesh daemon) via plain
// HTTP on the loopback. Override with $MESH_BASE_URL for non-default ports.

function meshBaseUrl(): string {
  return process.env.MESH_BASE_URL ?? 'http://localhost:8086';
}

const VALID_ACCOUNT_PATTERN = /^[a-z0-9_-]{1,32}$/i;

function assertValidAccount(account: string): void {
  if (!VALID_ACCOUNT_PATTERN.test(account)) {
    throw new Error(`Invalid mesh account name: ${account}`);
  }
}

async function fetchMeshAccounts(): Promise<MeshAccountsPayload> {
  const res = await fetch(`${meshBaseUrl()}/status`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`mesh /status ${res.status}`);
  const raw = (await res.json()) as Array<{ account: string; status: string }>;
  const accounts: MeshAccount[] = raw.map((r) => ({
    account: r.account,
    status: normalizeStatus(r.status),
  }));
  return { accounts };
}

async function fetchMeshChats(req: MeshChatsRequest): Promise<MeshChatsPayload> {
  assertValidAccount(req.account);
  const limit = clampLimit(req.limit, 50, 200);
  const url = `${meshBaseUrl()}/chats/${encodeURIComponent(req.account)}?limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`mesh /chats ${res.status}`);
  const chats = (await res.json()) as MeshChat[];
  return { chats };
}

async function fetchMeshMessages(req: MeshMessagesRequest): Promise<MeshMessagesPayload> {
  assertValidAccount(req.account);
  const limit = clampLimit(req.limit, 50, 500);
  const url = `${meshBaseUrl()}/messages/${encodeURIComponent(req.account)}/${encodeURIComponent(
    req.chatJid,
  )}?limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`mesh /messages ${res.status}`);
  const messages = (await res.json()) as MeshMessage[];
  return { messages };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function normalizeStatus(raw: string): MeshAccountStatus {
  switch (raw) {
    case 'open':
    case 'connecting':
    case 'close':
      return raw;
    default:
      return 'unknown';
  }
}

// ---- daemon utilityProcess --------------------------------------------------

function sendDaemon(msg: SupervisorInboundMessage): void {
  if (!daemonProcess) return;
  daemonProcess.postMessage(msg);
}

function spawnDaemon(): void {
  if (daemonProcess) return;
  // Co-located with index.js after build (electron-vite multi-entry main).
  const entry = join(__dirname, 'daemon.js');
  const proc = utilityProcess.fork(entry, [], {
    serviceName: 'rokibrain-daemon',
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: process.env['NODE_ENV'] ?? 'production',
    },
  });

  daemonProcess = proc;
  daemonReady = false;

  proc.stdout?.on('data', (d) => {
    process.stdout.write(`[daemon] ${d}`);
  });
  proc.stderr?.on('data', (d) => {
    process.stderr.write(`[daemon!] ${d}`);
  });

  proc.on('message', (m: SupervisorOutboundMessage) => handleDaemonMessage(m));
  proc.on('exit', (code) => {
    daemonProcess = null;
    daemonReady = false;
    daemonStatus = {
      status: 'crashed',
      changedAt: new Date().toISOString(),
      reason: `daemon exited with code=${code}`,
    };
    broadcast(IPC.DAEMON_STATUS, daemonStatus);
    // Restart with a small delay if app is still running and not quitting.
    if (!app.isReady() || isQuitting) return;
    setTimeout(() => spawnDaemon(), 2_000);
  });
}

let isQuitting = false;

function handleDaemonMessage(m: SupervisorOutboundMessage): void {
  switch (m.kind) {
    case 'ready':
      daemonReady = true;
      supervisorStatus = m.status;
      daemonStatus = {
        status: 'ready',
        changedAt: new Date().toISOString(),
      };
      broadcast(IPC.DAEMON_STATUS, daemonStatus);
      broadcast(IPC.DAEMON_SUPERVISOR_BROADCAST, m.status);
      // Auto-start registered children (none in M02; M04+ register theirs).
      sendDaemon({ kind: 'startAll' });
      break;
    case 'status':
      supervisorStatus = m.status;
      broadcast(IPC.DAEMON_SUPERVISOR_BROADCAST, m.status);
      while (pendingStatusResolvers.length > 0) {
        const r = pendingStatusResolvers.shift();
        r?.(m.status);
      }
      break;
    case 'wsPort':
      while (pendingWsPortResolvers.length > 0) {
        const r = pendingWsPortResolvers.shift();
        r?.({ port: m.port });
      }
      break;
    case 'error':
      daemonStatus = {
        status: 'degraded',
        changedAt: new Date().toISOString(),
        reason: m.message,
      };
      broadcast(IPC.DAEMON_STATUS, daemonStatus);
      break;
    case 'childStateChange':
      // No-op at the main level; renderer subscribes to supervisorBroadcast.
      break;
    default: {
      const _exhaustive: never = m;
      void _exhaustive;
    }
  }
}

async function shutdownDaemon(): Promise<void> {
  if (!daemonProcess) return;
  isQuitting = true;
  sendDaemon({ kind: 'stopAll', graceful: true });
  // Give the daemon ≤3s to exit cleanly before we let app.quit kill it.
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    daemonProcess?.once('exit', finish);
    setTimeout(finish, 3_000);
  });
  daemonProcess?.kill();
  daemonProcess = null;
}

// ---- global hotkeys --------------------------------------------------------

function registerHotkeys(): void {
  const numberKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
  numberKeys.forEach((key, idx) => {
    const accel = process.platform === 'darwin' ? `Cmd+${key}` : `Ctrl+${key}`;
    const tab = TAB_IDS[idx];
    if (!tab) return;
    globalShortcut.register(accel, () => {
      showOrCreateWindow();
      switchTab(tab, true);
    });
  });

  const voiceAccel = process.platform === 'darwin' ? 'Cmd+Shift+V' : 'Ctrl+Shift+V';
  globalShortcut.register(voiceAccel, () => toggleVoice());

  const pauseAccel = process.platform === 'darwin' ? 'Cmd+Shift+P' : 'Ctrl+Shift+P';
  globalShortcut.register(pauseAccel, () => togglePause());
}

// ---- daemon status broadcast (legacy daemon:status — supervised by M02) ----

function broadcastDaemonStatus(): void {
  broadcast(IPC.DAEMON_STATUS, daemonStatus);
}

function broadcastAuthStatus(payload: AuthStatusPayload): void {
  broadcast(IPC.AUTH_STATUS_CHANGE, payload);
}

// ---- lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  // M12: Register deep link protocol handler for rokibrain://enroll?token=...
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('rokibrain', process.execPath, [process.argv[1]]);
    }
  } else {
    app.setAsDefaultProtocolClient('rokibrain');
  }

  configureAutoUpdater();
  registerIpcHandlers();

  // M12: Initialize auth state from stored secrets.
  setAuthBroadcast(broadcastAuthStatus);
  void initAuth();

  mainWindow = createMainWindow();
  createTray();
  registerHotkeys();
  spawnDaemon();

  mainWindow.webContents.once('did-finish-load', () => {
    daemonStatus = {
      status: daemonReady ? 'ready' : 'starting',
      changedAt: new Date().toISOString(),
      reason: daemonReady ? undefined : 'daemon utilityProcess starting',
    };
    broadcastDaemonStatus();
    if (daemonReady) {
      broadcast(IPC.DAEMON_SUPERVISOR_BROADCAST, supervisorStatus);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    } else {
      showOrCreateWindow();
    }
  });
});

// M12: Handle deep link on macOS (open-url event).
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('rokibrain://enroll')) {
    void handleEnrollDeepLink(url);
  }
});

// M12: Handle deep link on Windows/Linux (second-instance event).
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // On Windows/Linux, the deep link URL comes as a command-line arg.
    const url = commandLine.find((arg) => arg.startsWith('rokibrain://'));
    if (url && url.startsWith('rokibrain://enroll')) {
      void handleEnrollDeepLink(url);
    }
    // Focus existing window if user tries to launch a second instance.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on('before-quit', async (e) => {
  if (!daemonProcess || isQuitting) return;
  e.preventDefault();
  await shutdownDaemon();
  app.quit();
});


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
