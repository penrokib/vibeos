// =============================================================================
// rokibrain.app — TmuxChild (M06b)
// -----------------------------------------------------------------------------
// Bridge-mac child that forwards tmux pane operations to Roki's existing Swift
// binary (`apps/bridge-mac/rokibrain-bridge` on M3, or configurable via env).
//
// Binary location resolution (v1):
//   1. VIBEOS_BRIDGE_MAC_PATH env (absolute path)
//   2. ~/.vibeos/bridge-mac/rokibrain-bridge (default)
//   3. If binary is missing at resolution time → degrade-mode (no throw)
//
// Degrade mode (binary not installed):
//   - status stays 'open' (child is running — just no real bridge)
//   - listPanes() returns one echo-stub pane with a friendly banner
//   - openPane/input/closePane log + emit output banner; no data forwarded
//
// Healthy mode (binary present):
//   - spawn subprocess with sanitized env (no API keys)
//   - stdin/stdout use line-delimited JSON envelopes (see BridgeEnvelope below)
//   - input() MUST call assertSafeTmuxKeystroke before forwarding (cc-modal
//     hardwall from feedback-cc-modal-dismiss.md)
//
// Hardwalls:
//   - assertSafeTmuxKeystroke IS called before EVERY keystroke forwarded
//   - UnsafeKeystrokeError → refusal emitted on output channel, never forwarded
//   - Bridge subprocess inherits sanitized env only (no SECRET/TOKEN/KEY vars)
//   - Renderer never receives raw bridge stdout/stderr — only structured events
//   - stop() sends SIGTERM, waits 5s, SIGKILLs if still alive
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BaseMeshChild, type ChildContext } from '../../base-child';
import { assertSafeTmuxKeystroke, UnsafeKeystrokeError } from '../../anti-ban';
import type { CockpitPane } from '../../../shared/ipc-contracts';
import type { HealthStatus, SupervisorMessage } from '../../types';

// ---------------------------------------------------------------------------
// Bridge line-delimited JSON protocol (v1)
// ---------------------------------------------------------------------------

/** Commands sent to bridge subprocess via stdin (newline-delimited JSON). */
export type BridgeCommand =
  | { cmd: 'listPanes' }
  | { cmd: 'openPane'; paneId: string; cols: number; rows: number }
  | { cmd: 'input'; paneId: string; data: string }
  | { cmd: 'closePane'; paneId: string };

/** Envelopes received from bridge subprocess stdout (newline-delimited JSON). */
export type BridgeEvent =
  | { evt: 'panes'; panes: Array<{ id: string; label: string }> }
  | { evt: 'output'; paneId: string; data: string }
  | { evt: 'error'; paneId?: string; message: string }
  | { evt: 'ack'; cmd: string };

// ---------------------------------------------------------------------------
// Output callback type (used by the cockpit IPC layer to broadcast output)
// ---------------------------------------------------------------------------

export type CockpitOutputCallback = (paneId: string, data: string) => void;

// ---------------------------------------------------------------------------
// TmuxChild
// ---------------------------------------------------------------------------

export class TmuxChild extends BaseMeshChild {
  /** Whether the bridge binary was found at start(). */
  private _degradeMode = false;
  /** Path to the bridge binary (resolved at construction, probed at start). */
  private readonly _binaryPath: string;
  /** Live bridge subprocess (healthy mode only). */
  private _proc: ChildProcess | null = null;
  /** Line buffer for partially-received stdout lines. */
  private _lineBuffer = '';
  /** Pending listPanes promise resolvers — keyed by sequence (v1 uses single queue). */
  private _panesResolvers: Array<(panes: CockpitPane[]) => void> = [];
  /** Whether we've been started. Idempotent guard. */
  private _started = false;
  /** Whether stop() has been called. */
  private _stopping = false;

  /** External output subscriber (cockpit IPC wires this up). */
  private _outputCallbacks = new Set<CockpitOutputCallback>();

  constructor(ctx: ChildContext) {
    super(ctx);
    this._binaryPath = resolveBinaryPath();
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Probe for the bridge binary. If missing → degrade mode (harmless).
   * Idempotent: safe to call twice.
   */
  override async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this._stopping = false;

    const exists = existsSync(this._binaryPath);
    if (!exists) {
      this._degradeMode = true;
      this.emit('started', {
        message: `tmux-child degrade-mode: bridge binary not found at ${this._binaryPath}`,
      });
      return;
    }

    this._degradeMode = false;
    this._spawnBridge();
    this.emit('started', {
      message: `tmux-child started bridge at ${this._binaryPath}`,
    });
  }

  /**
   * Stop the child. Sends SIGTERM; SIGKILLs after 5s if still alive.
   */
  override async stop(_graceful: boolean): Promise<void> {
    this._stopping = true;
    if (!this._proc) {
      this._started = false;
      this.emit('exited', { message: 'tmux-child stopped (degrade mode, no subprocess)' });
      return;
    }

    const proc = this._proc;
    this._proc = null;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };

      proc.once('exit', finish);

      // SIGTERM first
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be gone
        finish();
        return;
      }

      // SIGKILL after 5s
      const killTimer = setTimeout(() => {
        if (!done) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Already dead
          }
        }
      }, 5_000);

      proc.once('exit', () => {
        clearTimeout(killTimer);
        finish();
      });
    });

    this._started = false;
    this.emit('exited', { message: 'tmux-child bridge subprocess stopped' });
  }

  /** Health probe — called every 30s by Supervisor. */
  override async health(): Promise<HealthStatus> {
    if (this._degradeMode) {
      return {
        ok: true,
        detail: `tmux-child degrade-mode — bridge binary not at ${this._binaryPath}. Set VIBEOS_BRIDGE_MAC_PATH to override.`,
        metrics: { degradeMode: 1, bridgeRunning: 0 },
      };
    }
    if (!this._proc || this._proc.exitCode !== null) {
      return {
        ok: false,
        detail: 'tmux-child bridge subprocess not running',
        metrics: { degradeMode: 0, bridgeRunning: 0 },
      };
    }
    return {
      ok: true,
      detail: `tmux-child bridge pid=${this._proc.pid} running`,
      metrics: { degradeMode: 0, bridgeRunning: 1, pid: this._proc.pid ?? -1 },
    };
  }

  override async handleSupervisorMessage(msg: SupervisorMessage): Promise<void> {
    if (msg.kind === 'shutdown') {
      await this.stop(msg.graceful);
    }
    // pause/resume/health-probe/init: no-op in v1
  }

  // ---- cockpit API ----------------------------------------------------------

  /**
   * List tmux panes. In degrade mode, returns a single echo stub.
   * In healthy mode, queries the bridge subprocess.
   */
  async listPanes(): Promise<CockpitPane[]> {
    if (this._degradeMode || !this._proc) {
      return [
        {
          id: 'echo',
          label: `Echo (bridge-mac binary not installed at ${this._binaryPath} — falling back)`,
        },
      ];
    }

    return new Promise<CockpitPane[]>((resolve) => {
      // 2s timeout safety — never hang
      const timer = setTimeout(() => {
        const idx = this._panesResolvers.indexOf(resolve);
        if (idx >= 0) this._panesResolvers.splice(idx, 1);
        resolve([{ id: 'echo', label: 'listPanes timeout — bridge unresponsive' }]);
      }, 2_000);

      this._panesResolvers.push((panes) => {
        clearTimeout(timer);
        resolve(panes);
      });

      this._sendCommand({ cmd: 'listPanes' });
    });
  }

  /** Open a pane at the given dimensions. No-op in degrade mode. */
  async openPane(paneId: string, cols: number, rows: number): Promise<void> {
    if (this._degradeMode || !this._proc) {
      this._emitOutput(paneId, `[rokibrain] degrade-mode: bridge not installed at ${this._binaryPath}\r\n`);
      return;
    }
    this._sendCommand({ cmd: 'openPane', paneId, cols, rows });
  }

  /**
   * Forward keystroke input to the bridge subprocess.
   *
   * HARDWALL: assertSafeTmuxKeystroke is ALWAYS called first.
   * If it throws (cc-modal billing protection), the refusal is emitted
   * on the output channel and the keystroke is NOT forwarded.
   *
   * Concurrency: enqueueing is synchronous + ordered (Node.js event loop
   * guarantees ordering of microtasks within a tick). Parallel callers
   * produce serialised sends because _sendCommand writes to stdin atomically
   * per-call. Order is preserved.
   */
  input(paneId: string, data: string): void {
    // CC-modal hardwall (feedback-cc-modal-dismiss.md) — server-side enforcement.
    try {
      assertSafeTmuxKeystroke(data);
    } catch (err) {
      if (err instanceof UnsafeKeystrokeError) {
        const refusal = `[rokibrain] REFUSED: ${err.message}\r\n`;
        this._emitOutput(paneId, refusal);
        return;
      }
      throw err;
    }

    if (this._degradeMode || !this._proc) {
      // Degrade mode: echo with banner
      this._emitOutput(paneId, data + ' (echo — bridge-mac not installed)\r\n');
      return;
    }

    this._sendCommand({ cmd: 'input', paneId, data });
  }

  /** Close a pane. No-op in degrade mode. */
  async closePane(paneId: string): Promise<void> {
    if (this._degradeMode || !this._proc) return;
    this._sendCommand({ cmd: 'closePane', paneId });
  }

  // ---- output subscription --------------------------------------------------

  /**
   * Subscribe to cockpit output events. Callback receives (paneId, data).
   * Returns an unsubscribe function (mirrors BaseMeshChild.onEvent pattern).
   */
  onOutput(cb: CockpitOutputCallback): () => void {
    this._outputCallbacks.add(cb);
    return () => this._outputCallbacks.delete(cb);
  }

  // ---- accessors (tests) ----------------------------------------------------

  get degradeMode(): boolean { return this._degradeMode; }
  get binaryPath(): string { return this._binaryPath; }
  get proc(): ChildProcess | null { return this._proc; }

  // ---- private helpers -------------------------------------------------------

  private _spawnBridge(): void {
    const sanitizedEnv = sanitizeEnv(process.env);

    const proc = spawn(this._binaryPath, [], {
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._proc = proc;

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      this._lineBuffer += chunk;
      const lines = this._lineBuffer.split('\n');
      this._lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this._handleBridgeLine(trimmed);
      }
    });

    // Stderr → structured log only; never forwarded to renderer
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (data: string) => {
      // Surface as daemon log (stdout → daemon log forwarded by main)
      process.stdout.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: 'bridge-mac stderr',
          childId: this.id,
          data: data.slice(0, 512),
        }) + '\n',
      );
    });

    proc.on('exit', (code, signal) => {
      if (this._proc === proc) {
        this._proc = null;
      }
      if (!this._stopping) {
        this.emit('crashed', {
          message: `bridge subprocess exited unexpectedly (code=${String(code)} signal=${String(signal)})`,
        });
      }
    });

    proc.on('error', (err) => {
      if (!this._stopping) {
        this.emit('crashed', {
          message: `bridge spawn error: ${err.message}`,
        });
      }
    });
  }

  private _handleBridgeLine(line: string): void {
    let evt: BridgeEvent;
    try {
      evt = JSON.parse(line) as BridgeEvent;
    } catch {
      // Malformed line — ignore (don't crash the child)
      return;
    }

    switch (evt.evt) {
      case 'panes': {
        const panes: CockpitPane[] = (evt.panes ?? []).map((p) => ({
          id: p.id,
          label: p.label,
        }));
        const resolver = this._panesResolvers.shift();
        if (resolver) resolver(panes);
        break;
      }
      case 'output':
        this._emitOutput(evt.paneId, evt.data);
        break;
      case 'error':
        // Log; emit as output banner so renderer sees it without raw stderr
        this._emitOutput(
          evt.paneId ?? 'system',
          `[rokibrain-bridge error] ${evt.message}\r\n`,
        );
        break;
      case 'ack':
        // Acknowledgments — no-op in v1
        break;
    }
  }

  private _sendCommand(cmd: BridgeCommand): void {
    if (!this._proc?.stdin) return;
    const line = JSON.stringify(cmd) + '\n';
    this._proc.stdin.write(line);
  }

  private _emitOutput(paneId: string, data: string): void {
    // Emit to all cockpit output subscribers
    for (const cb of this._outputCallbacks) {
      try {
        cb(paneId, data);
      } catch (err) {
        process.stderr.write(`[TmuxChild] output callback threw: ${String(err)}\n`);
      }
    }
    // Also emit as a ChildEvent so Supervisor can observe
    this.emit('health', { data: { paneId, outputLen: data.length } });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBinaryPath(): string {
  const envPath = process.env['VIBEOS_BRIDGE_MAC_PATH'];
  if (envPath) return envPath;
  return join(homedir(), '.vibeos', 'bridge-mac', 'rokibrain-bridge');
}

/**
 * Return a copy of env with all vars whose names contain SECRET, TOKEN, KEY,
 * PASSWORD, CREDENTIAL, ANTHROPIC, OPENAI, or DEWX stripped out.
 * Bridge subprocess must not inherit API credentials.
 */
const SENSITIVE_PATTERN = /secret|token|key|password|credential|anthropic|openai|dewx/i;

export function sanitizeEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !SENSITIVE_PATTERN.test(k)) {
      result[k] = v;
    }
  }
  return result;
}
