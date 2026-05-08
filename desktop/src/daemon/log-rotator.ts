// =============================================================================
// rokibrain.app — daemon log rotator (M02)
// -----------------------------------------------------------------------------
// Per-child structured (JSONL) log writer with daily rotation. Logs land in
// ~/Library/Logs/rokibrain-app/daemon-<childId>.log on macOS,
// ~/.local/state/rokibrain-app/daemon-<childId>.log on Linux,
// %LOCALAPPDATA%/rokibrain-app/Logs/daemon-<childId>.log on Windows.
//
// Hard walls:
//   - Raw child stdout/stderr NEVER reaches the renderer (design §10 #15);
//     supervisor pipes streams here, renderer only sees structured `daemon:status`.
//   - Append-only — never truncate without rotation. Rotation = rename to
//     `<base>.YYYY-MM-DD.log` then re-open.
// =============================================================================

import { mkdir } from 'node:fs/promises';
import { createWriteStream, existsSync, renameSync, type WriteStream } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  childId: string;
  msg: string;
  data?: unknown;
}

export function defaultLogDir(): string {
  switch (osPlatform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Logs', 'rokibrain-app');
    case 'win32':
      return join(
        process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
        'rokibrain-app',
        'Logs',
      );
    default:
      return join(homedir(), '.local', 'state', 'rokibrain-app');
  }
}

/**
 * Per-child rotating logger. Single writer per (dir, childId). Caller is
 * responsible for `close()` on shutdown — supervisor handles this in
 * `Supervisor.stopAll()`.
 */
export class ChildLogger {
  private stream: WriteStream | null = null;
  private currentDay: string | null = null;
  private readonly path: string;
  private closed = false;

  constructor(
    private readonly childId: string,
    private readonly dir: string = defaultLogDir(),
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.path = join(this.dir, `daemon-${this.childId}.log`);
  }

  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.rotateIfNeeded();
  }

  /** Write a structured record as JSONL. Newline included. */
  write(record: Omit<LogRecord, 'ts' | 'childId'>): void {
    if (this.closed) return;
    this.rotateIfNeeded();
    const full: LogRecord = {
      ts: this.clock().toISOString(),
      childId: this.childId,
      ...record,
    };
    if (!this.stream) return; // not opened yet
    try {
      this.stream.write(JSON.stringify(full) + '\n');
    } catch {
      // swallow — we never want logging to crash the daemon
    }
  }

  /** Convenience helpers — shape parity with console-style APIs. */
  debug(msg: string, data?: unknown): void {
    this.write({ level: 'debug', msg, ...(data !== undefined ? { data } : {}) });
  }
  info(msg: string, data?: unknown): void {
    this.write({ level: 'info', msg, ...(data !== undefined ? { data } : {}) });
  }
  warn(msg: string, data?: unknown): void {
    this.write({ level: 'warn', msg, ...(data !== undefined ? { data } : {}) });
  }
  error(msg: string, data?: unknown): void {
    this.write({ level: 'error', msg, ...(data !== undefined ? { data } : {}) });
  }

  async close(): Promise<void> {
    this.closed = true;
    await new Promise<void>((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }
      this.stream.end(() => resolve());
    });
    this.stream = null;
  }

  private rotateIfNeeded(): void {
    const today = this.clock().toISOString().slice(0, 10); // YYYY-MM-DD
    if (this.currentDay === today && this.stream) return;

    // close previous stream synchronously enough for rename to work
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        /* ignore */
      }
      this.stream = null;
    }

    // archive yesterday's file if present (rename → <base>.<prevDay>.log).
    // Swallow ENOENT — the live file may not exist yet on first rotate (no
    // writes flushed). Better than gating on existsSync which races the
    // writeStream's lazy file creation.
    if (this.currentDay && this.currentDay !== today) {
      const archived = join(
        dirname(this.path),
        `daemon-${this.childId}.${this.currentDay}.log`,
      );
      try {
        if (existsSync(this.path)) {
          renameSync(this.path, archived);
        }
      } catch {
        // If rotate fails (file locked etc.), keep appending to the live file —
        // better than losing logs.
      }
    }

    this.currentDay = today;
    this.stream = createWriteStream(this.path, { flags: 'a' });
  }
}

/** Test seam: build a logger with an injected clock + a tmp dir. */
export function buildLoggerForTest(
  childId: string,
  dir: string,
  clock: () => Date,
): ChildLogger {
  return new ChildLogger(childId, dir, clock);
}
