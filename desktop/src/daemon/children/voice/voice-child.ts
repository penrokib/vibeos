// =============================================================================
// rokibrain.app — VoiceChild (M11)
// -----------------------------------------------------------------------------
// Wraps whisper.cpp for in-process transcription. Audio bytes are NEVER written
// to disk (security hardwall #14 — see Part XIII of the architecture doc).
//
// Lifecycle:
//   start()     — probe for the whisper binary; sets degraded flag if missing.
//   transcribe() — spawn whisper-cpp with stdin pipe; pipe buffer → stdout text.
//   stop()      — no persistent sub-process to kill in v1; no-op.
//   health()    — returns ok=true if binary is found (or degraded=known).
//
// Hardwall contract:
//   - NEVER call fs.writeFile / fs.writeFileSync with audio data.
//   - NEVER pass a temp-file path to whisper — always pipe via stdin.
//   - Sanitised env (no API keys) passed to the child process.
//   - On any error → degrade gracefully; never throw to supervisor.
// =============================================================================

import { spawn } from 'node:child_process';
import { which } from './which-helper';
import { BaseMeshChild, type ChildContext } from '../../base-child';
import type { HealthStatus, SupervisorMessage } from '../../types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VoiceChildOptions {
  /**
   * Absolute path to whisper-cpp binary.
   * Defaults to env VIBEOS_WHISPER_PATH, then probes PATH for 'whisper-cpp'.
   */
  whisperBinaryPath?: string;
  /**
   * Path to the whisper model file (.bin).
   * Defaults to env VIBEOS_WHISPER_MODEL, then 'model.bin' (relative to CWD).
   */
  modelPath?: string;
  /** Maximum ms to wait for whisper subprocess before timing out. Default 30_000. */
  timeoutMs?: number;
  /**
   * Injectable spawn implementation for tests.
   * Matches the signature of child_process.spawn.
   */
  spawnImpl?: typeof spawn;
  /**
   * Injectable which implementation for tests.
   */
  whichImpl?: (cmd: string) => Promise<string | null>;
}

export interface TranscribeResult {
  text: string;
  durationMs: number;
  /** True when whisper.cpp binary is missing; text contains install instructions. */
  degraded?: boolean;
}

// ---------------------------------------------------------------------------
// Degrade-mode banner (hardwall §14: never mention file paths)
// ---------------------------------------------------------------------------
const DEGRADE_BANNER =
  '[whisper.cpp not installed — install via: brew install whisper-cpp]';

// ---------------------------------------------------------------------------
// VoiceChild
// ---------------------------------------------------------------------------

export class VoiceChild extends BaseMeshChild {
  private readonly whisperBinaryPath: string;
  private readonly modelPath: string;
  private readonly timeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly whichImpl: (cmd: string) => Promise<string | null>;

  private _started = false;
  private _degraded = false;
  private _resolvedBinary: string | null = null;

  constructor(ctx: ChildContext, opts: VoiceChildOptions = {}) {
    super(ctx);
    this.whisperBinaryPath =
      opts.whisperBinaryPath ??
      process.env['VIBEOS_WHISPER_PATH'] ??
      'whisper-cpp';
    this.modelPath =
      opts.modelPath ?? process.env['VIBEOS_WHISPER_MODEL'] ?? 'model.bin';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.whichImpl = opts.whichImpl ?? which;
  }

  // ---- lifecycle ------------------------------------------------------------

  override async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    const resolved = await this.whichImpl(this.whisperBinaryPath);
    if (!resolved) {
      this._degraded = true;
      this._resolvedBinary = null;
      this.emit('started', {
        message: `voice-child: whisper.cpp not found at '${this.whisperBinaryPath}' — degraded mode`,
      });
      return;
    }

    this._resolvedBinary = resolved;
    this._degraded = false;
    this.emit('started', {
      message: `voice-child: whisper.cpp found at ${resolved}`,
    });
  }

  override async stop(_graceful: boolean): Promise<void> {
    // v1: whisper spawned per-call, no persistent process to kill.
    this._started = false;
    this.emit('exited', { message: 'voice-child stopped' });
  }

  override async health(): Promise<HealthStatus> {
    if (this._degraded) {
      return {
        ok: false,
        detail: `voice-child degraded: whisper.cpp not found at '${this.whisperBinaryPath}'`,
        metrics: { degraded: 1 },
      };
    }
    return {
      ok: this._started,
      detail: `voice-child ok; binary=${this._resolvedBinary ?? 'unknown'}`,
      metrics: { degraded: 0 },
    };
  }

  override async handleSupervisorMessage(msg: SupervisorMessage): Promise<void> {
    if (msg.kind === 'shutdown') {
      await this.stop(msg.graceful);
    }
  }

  // ---- transcription API ----------------------------------------------------

  /**
   * Transcribe an audio buffer via whisper.cpp.
   *
   * HARDWALL §14: audio bytes are passed via stdin pipe — NEVER written to
   * disk. The caller (main/IPC handler) receives transcribed text only.
   *
   * @param audioBuffer - WebM/Opus (or WAV) audio captured in RAM by renderer.
   * @returns Transcript text + duration, or degrade-mode banner on error.
   */
  async transcribe(audioBuffer: Buffer): Promise<TranscribeResult> {
    const t0 = Date.now();

    if (this._degraded || !this._resolvedBinary) {
      return { text: DEGRADE_BANNER, durationMs: 0, degraded: true };
    }

    return new Promise<TranscribeResult>((resolve) => {
      let settled = false;
      const finish = (result: TranscribeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let stdoutBuf = '';
      let stderrBuf = '';

      // Sanitised environment — strip API key env vars before spawning.
      const safeEnv: NodeJS.ProcessEnv = {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        TMPDIR: process.env['TMPDIR'],
        LANG: process.env['LANG'],
        LC_ALL: process.env['LC_ALL'],
      };

      const child = this.spawnImpl(
        this._resolvedBinary!,
        [
          '-m', this.modelPath,
          // Read from stdin ('-' means stdin for whisper-cpp CLI)
          '-f', 'pipe:0',
          '--output-txt',
          '--no-timestamps',
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: safeEnv,
        },
      );

      // Timeout guard
      const timer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
          finish({
            text: '[voice: whisper.cpp timed out]',
            durationMs: Date.now() - t0,
            degraded: true,
          });
        }
      }, this.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutBuf += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrBuf += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        console.error('[voice-child] whisper spawn error:', err.message);
        finish({
          text: `[voice: whisper.cpp error — ${err.message}]`,
          durationMs: Date.now() - t0,
          degraded: true,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const detail = stderrBuf.trim() || `exit code ${code}`;
          finish({
            text: `[voice: whisper.cpp failed — ${detail}]`,
            durationMs: Date.now() - t0,
            degraded: true,
          });
          return;
        }
        const text = stdoutBuf.trim() || '';
        finish({ text, durationMs: Date.now() - t0 });
      });

      // HARDWALL §14: pipe buffer via stdin — never fs.writeFile
      try {
        child.stdin!.write(audioBuffer);
        child.stdin!.end();
      } catch (err) {
        clearTimeout(timer);
        console.error('[voice-child] stdin write error:', err);
        finish({
          text: '[voice: failed to pipe audio to whisper.cpp]',
          durationMs: Date.now() - t0,
          degraded: true,
        });
      }
    });
  }

  // ---- accessors (test/supervisor visibility) --------------------------------

  get degraded(): boolean {
    return this._degraded;
  }

  get resolvedBinary(): string | null {
    return this._resolvedBinary;
  }
}
