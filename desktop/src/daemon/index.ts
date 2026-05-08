// =============================================================================
// rokibrain.app — daemon entry (M02)
// -----------------------------------------------------------------------------
// Runs in an Electron utilityProcess (NOT child_process.fork) — see
// design §1 + locked-decisions §1. utilityProcess gives us proper structured-
// clone IPC + sandbox-capable execution + clean shutdown semantics.
//
// This file is the entry POINT loaded by `utilityProcess.fork(__dirname/index.js)`
// from src/main/index.ts. It never imports Electron itself; the only IPC out is
// `process.parentPort` (utilityProcess API) — provided by the runtime.
//
// Lifecycle:
//   1. main forks this file with `serviceName='rokibrain-daemon'`.
//   2. We boot Supervisor + DaemonWsServer + (HTTP BFF counter client when env
//      provides token+url; otherwise tests inject a mock).
//   3. We post `{ kind: 'ready', wsPort, status }` to parentPort.
//   4. Main bridges renderer IPC ↔ parentPort messages.
//
// Shape of supervisor → main message: SupervisorOutboundMessage.
// Shape of main → supervisor message: SupervisorInboundMessage.
// =============================================================================

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  HttpBffCounterClient,
  setBffCounterClient,
  type BffCounterClient,
} from './anti-ban';
import { Supervisor } from './supervisor';
import { EnvJwtAuth, DaemonWsServer } from './ws-server';
import type { SupervisorStatus, ChildState } from './types';
import { WaChild } from './children/wa/wa-child';
import { TmuxChild } from './children/tmux/tmux-child';
import { VoiceChild } from './children/voice/voice-child';
import { MeshMcpServer } from './mcp/mesh-mcp-server';
import { SearchService } from './search/search.service';
import { DigestGenerator } from './digest/digest-generator';
import { FleetManager } from './cc-fleet/fleet-manager';

// -----------------------------------------------------------------------------
// IPC envelope between main and daemon utilityProcess.
// -----------------------------------------------------------------------------

export type SupervisorInboundMessage =
  | { kind: 'startAll' }
  | { kind: 'stopAll'; graceful?: boolean }
  | { kind: 'emergencyStop' }
  | { kind: 'resume' }
  | { kind: 'unlock'; childId: string }
  | { kind: 'getStatus' }
  | { kind: 'getWsPort' };

export type SupervisorOutboundMessage =
  | { kind: 'ready'; wsPort: number; status: SupervisorStatus }
  | { kind: 'status'; status: SupervisorStatus }
  | { kind: 'wsPort'; port: number }
  | { kind: 'error'; message: string }
  | {
      kind: 'childStateChange';
      childId: string;
      state: ChildState;
      message?: string;
    };

// -----------------------------------------------------------------------------
// Runtime parentPort handle — utilityProcess provides this. We import lazily
// so unit tests that import this module don't crash on `process.parentPort`.
// -----------------------------------------------------------------------------

interface ParentPortLike {
  postMessage: (m: SupervisorOutboundMessage) => void;
  on: (
    evt: 'message',
    cb: (m: { data: SupervisorInboundMessage }) => void,
  ) => void;
}

function getParentPort(): ParentPortLike | null {
  // process.parentPort is only present in utilityProcess context.
  const pp = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  return pp ?? null;
}

// -----------------------------------------------------------------------------
// Userdata path for the port-discovery file (M01 hand-off).
// -----------------------------------------------------------------------------

function userDataDir(): string {
  switch (osPlatform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'rokibrain.app');
    case 'win32':
      return join(
        process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'),
        'rokibrain.app',
      );
    default:
      return join(homedir(), '.config', 'rokibrain.app');
  }
}

async function writePortFile(port: number): Promise<void> {
  const dir = userDataDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'daemon.port'), String(port), { mode: 0o600 });
}

/**
 * Write the MCP token file used by the vibeos-mcp-shim.
 * Stored at ~/Library/Application Support/vibeOS/mcp-token.json (mode 0o600).
 * The token is also written to process.env.VIBEOS_MCP_TOKEN for in-process use.
 * NEVER log or expose the token value.
 */
async function writeMcpTokenFile(port: number, token: string): Promise<void> {
  // vibeOS userdata dir (distinct from rokibrain.app dir)
  let dir: string;
  switch (osPlatform()) {
    case 'darwin':
      dir = join(homedir(), 'Library', 'Application Support', 'vibeOS');
      break;
    case 'win32':
      dir = join(
        process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'),
        'vibeOS',
      );
      break;
    default:
      dir = join(homedir(), '.config', 'vibeOS');
  }
  await mkdir(dir, { recursive: true });
  const content = JSON.stringify({ port, token });
  await writeFile(join(dir, 'mcp-token.json'), content, { mode: 0o600 });
}

// -----------------------------------------------------------------------------
// Daemon bootstrap.
// -----------------------------------------------------------------------------

export interface DaemonBootstrapOptions {
  parentPort?: ParentPortLike;
  /** Override BFF client — used by tests + when env is unconfigured. */
  bffClient?: BffCounterClient;
  /** Override WS port (0 = ephemeral). */
  wsPort?: number;
  /** Disable port-file write (tests). */
  skipPortFile?: boolean;
  /** Disable MCP token file write (tests). */
  skipMcpTokenFile?: boolean;
}

export interface DaemonBootstrapResult {
  supervisor: Supervisor;
  ws: DaemonWsServer;
  meshMcp: MeshMcpServer;
  /** Returns the MCP port (same as WS port — MCP shares the daemon WS port). */
  getMcpPort: () => number;
  shutdown: () => Promise<void>;
}

export async function bootstrapDaemon(
  opts: DaemonBootstrapOptions = {},
): Promise<DaemonBootstrapResult> {
  const supervisor = new Supervisor();

  // ---- M04: WaChild registration (MESH_WA_ENABLED=true gates activation) ---
  // Default OFF in v1 — set MESH_WA_ENABLED=true to opt in.
  // MESH_WA_BASE_URL overrides the backend URL (env-only, no committed value).
  if (process.env['MESH_WA_ENABLED'] === 'true') {
    supervisor.register(
      { id: 'wa-personal', platform: 'whatsapp' },
      async (ctx) =>
        new WaChild(ctx, {
          account: 'personal',
          // baseUrl falls through to env MESH_WA_BASE_URL → http://localhost:8086
        }),
    );
    log('info', 'wa-personal child registered (MESH_WA_ENABLED=true)');
  }

  // ---- M06b: TmuxChild registration (MESH_TMUX_ENABLED, default ON) ----------
  // Default ON because degrade mode is harmless when binary isn't installed.
  // Set MESH_TMUX_ENABLED=false to opt out.
  // VIBEOS_BRIDGE_MAC_PATH overrides the bridge binary path (env-only).
  if (process.env['MESH_TMUX_ENABLED'] !== 'false') {
    supervisor.register(
      { id: 'tmux', platform: 'tmux' },
      async (ctx) => {
        const child = new TmuxChild(ctx);
        return child;
      },
    );
    log('info', 'tmux child registered (MESH_TMUX_ENABLED default=on)');
  }

  // ---- M11: VoiceChild registration (always registered; degrades gracefully) --
  // Binary probe happens in start(). If whisper-cpp is missing, voice-child
  // enters degraded mode and returns the install banner on transcribe().
  // Override binary via VIBEOS_WHISPER_PATH; model via VIBEOS_WHISPER_MODEL.
  supervisor.register(
    { id: 'voice', platform: 'voice' },
    async (ctx) => new VoiceChild(ctx),
  );
  log('info', 'voice child registered');

  const ws = new DaemonWsServer({
    auth: new EnvJwtAuth(),
    port: opts.wsPort ?? 0,
    logger: {
      info: (m, d) => log('info', m, d),
      warn: (m, d) => log('warn', m, d),
    },
  });
  await ws.listen();
  supervisor.setWsPort(ws.port);

  if (!opts.skipPortFile) {
    try {
      await writePortFile(ws.port);
    } catch (err) {
      log('warn', 'failed to write port file', { err: String(err) });
    }
  }

  // Anti-ban client wiring. Prefer injected (tests); else build from env.
  if (opts.bffClient) {
    setBffCounterClient(opts.bffClient);
  } else if (process.env['ROKIBRAIN_BFF_URL'] && process.env['ROKIBRAIN_DEV_JWT']) {
    setBffCounterClient(
      new HttpBffCounterClient({
        baseUrl: process.env['ROKIBRAIN_BFF_URL'],
        token: process.env['ROKIBRAIN_DEV_JWT'],
      }),
    );
  } else {
    // Failing closed — no client = every withAntiBan call refuses.
    setBffCounterClient(null);
  }

  // ---- Cycle 16: MeshMcpServer + MCP token -----------------------------------
  // Generate a random JWT token and wire the MeshMcpServer. Token is written to
  // the vibeOS userdata dir (0o600) for the vibeos-mcp-shim to read.
  const mcpToken = randomBytes(32).toString('hex');
  process.env['VIBEOS_MCP_TOKEN'] = mcpToken;

  const searchService = new SearchService();
  // FleetManager + DigestGenerator are lightweight — instantiate unconditionally.
  const fleetManager = new FleetManager();
  const digestGenerator = new DigestGenerator(fleetManager);

  const meshMcp = new MeshMcpServer({
    supervisor,
    searchService,
    digestGenerator,
  });
  log('info', 'MeshMcpServer instantiated (Cycle 16)');

  if (!opts.skipMcpTokenFile) {
    try {
      await writeMcpTokenFile(ws.port, mcpToken);
      log('info', 'MCP token file written');
    } catch (err) {
      log('warn', 'failed to write MCP token file', { err: String(err) });
    }
  }

  const parent = opts.parentPort ?? getParentPort();
  if (parent) {
    wireParentPort(parent, supervisor);
  }

  const getMcpPort = (): number => ws.port;

  const shutdown = async (): Promise<void> => {
    await meshMcp.close().catch(() => undefined);
    await supervisor.stopAll(true);
    await ws.close();
  };

  if (parent) {
    parent.postMessage({
      kind: 'ready',
      wsPort: ws.port,
      status: supervisor.status(),
    });
  }

  return { supervisor, ws, meshMcp, getMcpPort, shutdown };
}

function wireParentPort(parent: ParentPortLike, supervisor: Supervisor): void {
  supervisor.onStatusChange((status) => {
    parent.postMessage({ kind: 'status', status });
  });

  parent.on('message', (m) => {
    void handleInbound(parent, supervisor, m.data);
  });

  // Best-effort clean shutdown when main quits.
  process.on('SIGTERM', () => {
    void supervisor.stopAll(true).then(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void supervisor.stopAll(true).then(() => process.exit(0));
  });
}

async function handleInbound(
  parent: ParentPortLike,
  supervisor: Supervisor,
  msg: SupervisorInboundMessage,
): Promise<void> {
  try {
    switch (msg.kind) {
      case 'startAll':
        await supervisor.startAll();
        break;
      case 'stopAll':
        await supervisor.stopAll(msg.graceful ?? true);
        break;
      case 'emergencyStop':
        await supervisor.emergencyStop();
        break;
      case 'resume':
        supervisor.resume();
        break;
      case 'unlock':
        supervisor.unlock(msg.childId);
        break;
      case 'getStatus':
        parent.postMessage({ kind: 'status', status: supervisor.status() });
        break;
      case 'getWsPort':
        parent.postMessage({ kind: 'wsPort', port: supervisor.status().wsPort });
        break;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  } catch (err) {
    parent.postMessage({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function log(level: 'info' | 'warn', msg: string, data?: unknown): void {
  // Daemon-internal logging — falls through to stderr (which Electron pipes
  // to ~/Library/Logs/rokibrain-app/stderr.log via launchd). Children get
  // their own per-child loggers via ChildLogger.
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, data });
  if (level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

// -----------------------------------------------------------------------------
// Auto-bootstrap when loaded as the utilityProcess entry. Skip when imported
// from tests (jest sets `NODE_ENV='test'`).
// -----------------------------------------------------------------------------

if (process.env['NODE_ENV'] !== 'test' && getParentPort()) {
  bootstrapDaemon().catch((err) => {
    process.stderr.write(`daemon bootstrap failed: ${String(err)}\n`);
    process.exit(1);
  });
}
