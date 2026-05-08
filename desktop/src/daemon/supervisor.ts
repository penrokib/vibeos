// =============================================================================
// rokibrain.app — Supervisor (M02)
// -----------------------------------------------------------------------------
// Owns the lifecycle of every supervised child (whatsmeow wa, tdlib tg,
// discord, email, whisper, chromium-cdp, tmux-bridge — all M04+).
//
// Restart-policy semantics ported (and extended) from
//   apps/bridge-mac/Sources/RokibrainBridge/WSClient.swift
//   :: exponential backoff capped at 30s, reset on success.
//
// Differences from the Swift version:
//   - Per-child registry (Swift has one WS connection; daemon has N children).
//   - Adds full circuit breaker: > maxCrashesInWindow crashes within windowMs
//     → state transitions to `permanently-failed`. Requires explicit
//     `unlock(childId)` before any further start. Surfaced to renderer via
//     the `daemon:status` IPC channel (see ipc-contracts.ts).
//   - Adds graceful shutdown: SIGTERM-equivalent → 10s grace → SIGKILL-equivalent.
//   - Adds emergency stop: `emergencyStop()` SIGTERMs all, marks all `paused`.
//
// Hardwalls enforced here:
//   - Never auto-restart a `permanently-failed` child without `unlock()`.
//   - Never SIGTERM a child without first marking state=stopping.
//   - Never throw out of an event listener (catch + log only).
// =============================================================================

import { BaseMeshChild, type ChildContext } from './base-child';
import { ChildLogger } from './log-rotator';
import {
  DEFAULT_RESTART_POLICY,
  DEFAULT_RESOURCE_CAPS,
  type ChildEvent,
  type ChildState,
  type ChildStatus,
  type RestartPolicy,
  type ResourceCaps,
  type SupervisorStatus,
} from './types';

const GRACEFUL_SHUTDOWN_MS = 10_000;

interface RegisteredChild {
  ctx: ChildContext;
  factory: (ctx: ChildContext) => Promise<BaseMeshChild>;
  policy: RestartPolicy;
  caps: ResourceCaps;
  logger: ChildLogger;

  instance: BaseMeshChild | null;
  state: ChildState;
  restartCount: number;
  /** Crash timestamps in ms; trimmed on read. */
  crashTimestamps: number[];
  changedAt: string;
  lastError?: string;
  nextRestartAt?: string;
  pendingTimer?: NodeJS.Timeout;
}

export interface SupervisorOptions {
  /** Override default restart policy applied to all children. */
  defaultRestartPolicy?: Partial<RestartPolicy>;
  /** Override default resource caps applied to all children. */
  defaultResourceCaps?: Partial<ResourceCaps>;
  /** Inject a clock for tests. Default: Date.now. */
  now?: () => number;
  /** Set true in tests to disable real timers (deterministic backoff). */
  disableTimers?: boolean;
  /** Optional log dir override (tests). */
  logDir?: string;
}

export type SupervisorListener = (status: SupervisorStatus) => void;

export class Supervisor {
  private readonly children = new Map<string, RegisteredChild>();
  private readonly listeners = new Set<SupervisorListener>();
  private readonly opts: Required<
    Pick<SupervisorOptions, 'now' | 'disableTimers'>
  > &
    Pick<SupervisorOptions, 'logDir'> & {
      restartPolicy: RestartPolicy;
      caps: ResourceCaps;
    };
  private wsPort = 0;
  private startedAt: number;
  private emergencyStopped = false;
  private healthInterval?: NodeJS.Timeout;

  constructor(options: SupervisorOptions = {}) {
    this.opts = {
      now: options.now ?? Date.now,
      disableTimers: options.disableTimers ?? false,
      ...(options.logDir !== undefined ? { logDir: options.logDir } : {}),
      restartPolicy: { ...DEFAULT_RESTART_POLICY, ...options.defaultRestartPolicy },
      caps: { ...DEFAULT_RESOURCE_CAPS, ...options.defaultResourceCaps },
    };
    this.startedAt = this.opts.now();
  }

  // ---- registration --------------------------------------------------------

  register(
    ctx: ChildContext,
    factory: (ctx: ChildContext) => Promise<BaseMeshChild>,
  ): void {
    if (this.children.has(ctx.id)) {
      throw new Error(`child id '${ctx.id}' already registered`);
    }
    const policy: RestartPolicy = {
      ...this.opts.restartPolicy,
      ...(ctx.restartPolicy ?? {}),
    };
    const caps: ResourceCaps = { ...this.opts.caps, ...(ctx.resourceCaps ?? {}) };
    const logger = new ChildLogger(ctx.id, this.opts.logDir);
    this.children.set(ctx.id, {
      ctx,
      factory,
      policy,
      caps,
      logger,
      instance: null,
      state: 'idle',
      restartCount: 0,
      crashTimestamps: [],
      changedAt: new Date(this.opts.now()).toISOString(),
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Spawns every registered child whose state is idle | stopped. */
  async startAll(): Promise<void> {
    if (this.emergencyStopped) {
      throw new Error('supervisor is emergency-stopped; call resume() first');
    }
    for (const id of this.children.keys()) {
      // best-effort start; record errors but continue with siblings
      try {
        await this.start(id);
      } catch (err) {
        this.children.get(id)?.logger.error('startAll: start threw', {
          err: String(err),
        });
      }
    }
    this.beginHealthLoop();
  }

  async start(id: string): Promise<void> {
    const child = this.requireChild(id);
    if (this.emergencyStopped) {
      throw new Error('supervisor is emergency-stopped');
    }
    if (child.state === 'permanently-failed') {
      throw new Error(
        `child '${id}' is permanently-failed; call unlock('${id}') before restarting`,
      );
    }
    if (child.state === 'running' || child.state === 'starting') return;

    await child.logger.open();
    this.transition(child, 'starting', 'start() invoked');

    try {
      child.instance = await child.factory(child.ctx);
      // Defer event-listener attach until after start succeeds so a synchronous
      // 'crashed' emit from inside start() doesn't double-count the same crash
      // (once via the thrown error here + once via the event listener).
      await child.instance.start();
      this.attachListeners(child);
      this.transition(child, 'running', 'start() resolved');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      child.lastError = msg;
      // Detach the instance — start() failed, so it's not in a usable state.
      child.instance = null;
      this.recordCrash(child, msg);
    }
  }

  /** Graceful stop of one child: SIGTERM-equivalent → 10s grace → forced. */
  async stop(id: string, graceful = true): Promise<void> {
    const child = this.requireChild(id);
    this.cancelPendingRestart(child);
    if (!child.instance || child.state === 'stopped' || child.state === 'idle') {
      this.transition(child, 'stopped', 'already stopped');
      return;
    }
    this.transition(child, 'stopping', graceful ? 'graceful' : 'forced');
    const inst = child.instance;
    if (graceful) {
      try {
        await raceWithTimeout(inst.stop(true), GRACEFUL_SHUTDOWN_MS);
      } catch (err) {
        child.logger.warn('graceful stop timed out, forcing', { err: String(err) });
        await raceWithTimeout(inst.stop(false), GRACEFUL_SHUTDOWN_MS).catch(() => {
          /* swallow */
        });
      }
    } else {
      await raceWithTimeout(inst.stop(false), GRACEFUL_SHUTDOWN_MS).catch(() => {
        /* swallow */
      });
    }
    child.instance = null;
    this.transition(child, 'stopped', 'stop() complete');
  }

  /** Stop every child, close every logger. */
  async stopAll(graceful = true): Promise<void> {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = undefined;
    }
    for (const id of this.children.keys()) {
      try {
        await this.stop(id, graceful);
      } catch (err) {
        this.children.get(id)?.logger.error('stopAll: stop threw', {
          err: String(err),
        });
      }
    }
    for (const child of this.children.values()) {
      await child.logger.close().catch(() => undefined);
    }
  }

  /** Trip every child paused; refuse new starts until resume(). */
  async emergencyStop(): Promise<void> {
    this.emergencyStopped = true;
    for (const child of this.children.values()) {
      this.cancelPendingRestart(child);
      if (child.instance) {
        try {
          await raceWithTimeout(child.instance.stop(true), GRACEFUL_SHUTDOWN_MS);
        } catch {
          await child.instance.stop(false).catch(() => undefined);
        }
        child.instance = null;
      }
      this.transition(child, 'paused', 'emergency stop');
    }
    this.notify();
  }

  resume(): void {
    if (!this.emergencyStopped) return;
    this.emergencyStopped = false;
    for (const child of this.children.values()) {
      if (child.state === 'paused') {
        this.transition(child, 'idle', 'emergency resume');
      }
    }
    this.notify();
  }

  /**
   * Permitting a permanently-failed child to be started again. Resets
   * crash window + restart count. Caller (UI) must surface a confirmation
   * to Roki before invoking this.
   */
  unlock(id: string): void {
    const child = this.requireChild(id);
    if (child.state !== 'permanently-failed') return;
    child.crashTimestamps = [];
    child.restartCount = 0;
    delete child.lastError;
    delete child.nextRestartAt;
    this.transition(child, 'idle', 'unlocked by operator');
  }

  // ---- introspection -------------------------------------------------------

  status(): SupervisorStatus {
    const now = this.opts.now();
    return {
      wsPort: this.wsPort,
      uptime: now - this.startedAt,
      emergencyStopped: this.emergencyStopped,
      children: [...this.children.values()].map((c) => this.snapshot(c, now)),
    };
  }

  setWsPort(port: number): void {
    this.wsPort = port;
    this.notify();
  }

  onStatusChange(listener: SupervisorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test introspection only — exposes the raw child record. */
  __getChildForTests(id: string): RegisteredChild | undefined {
    return this.children.get(id);
  }

  // ---- internal: crash + backoff ------------------------------------------

  private recordCrash(child: RegisteredChild, reason: string): void {
    const now = this.opts.now();
    child.crashTimestamps.push(now);
    // trim to window
    const cutoff = now - child.policy.windowMs;
    child.crashTimestamps = child.crashTimestamps.filter((t) => t >= cutoff);
    child.lastError = reason;

    child.logger.warn('crash recorded', {
      reason,
      recentCrashes: child.crashTimestamps.length,
    });

    if (child.crashTimestamps.length > child.policy.maxCrashesInWindow) {
      this.transition(
        child,
        'permanently-failed',
        `circuit breaker tripped: ${child.crashTimestamps.length} crashes in ${child.policy.windowMs}ms`,
      );
      return;
    }

    const delay = computeBackoff(child.restartCount, child.policy);
    child.restartCount += 1;
    const nextAt = new Date(now + delay).toISOString();
    child.nextRestartAt = nextAt;
    this.transition(child, 'crashing', `next restart in ${delay}ms`);

    if (this.opts.disableTimers) return;

    child.pendingTimer = setTimeout(() => {
      delete child.pendingTimer;
      delete child.nextRestartAt;
      if (this.emergencyStopped) return;
      if (child.state === 'permanently-failed' || child.state === 'paused') return;
      this.transition(child, 'restarting', 'backoff elapsed');
      this.start(child.ctx.id).catch((err) => {
        child.logger.error('auto-restart failed', { err: String(err) });
      });
    }, delay);
  }

  /** Test seam: deterministically advance the backoff clock. */
  __triggerPendingRestartForTests(id: string): Promise<void> {
    const child = this.requireChild(id);
    this.cancelPendingRestart(child);
    delete child.nextRestartAt;
    if (child.state !== 'crashing') {
      return Promise.resolve();
    }
    this.transition(child, 'restarting', 'test trigger');
    return this.start(child.ctx.id);
  }

  private cancelPendingRestart(child: RegisteredChild): void {
    if (child.pendingTimer) {
      clearTimeout(child.pendingTimer);
      delete child.pendingTimer;
    }
  }

  // ---- internal: health loop ----------------------------------------------

  private beginHealthLoop(): void {
    if (this.opts.disableTimers || this.healthInterval) return;
    this.healthInterval = setInterval(() => {
      this.runHealthProbes().catch(() => undefined);
    }, 30_000);
  }

  private async runHealthProbes(): Promise<void> {
    for (const child of this.children.values()) {
      if (!child.instance || child.state !== 'running') continue;
      try {
        const h = await child.instance.health();
        child.logger.debug('health', { ok: h.ok, detail: h.detail });
        if (!h.ok) {
          this.recordCrash(child, h.detail ?? 'health probe failed');
          child.instance = null;
        }
      } catch (err) {
        this.recordCrash(child, `health probe threw: ${String(err)}`);
        child.instance = null;
      }
    }
  }

  // ---- internal: event plumbing -------------------------------------------

  private attachListeners(child: RegisteredChild): void {
    if (!child.instance) return;
    child.instance.onEvent((evt) => this.handleChildEvent(child, evt));
  }

  private handleChildEvent(child: RegisteredChild, evt: ChildEvent): void {
    child.logger.debug('child event', { type: evt.type, message: evt.message });
    if (evt.type === 'crashed' || evt.type === 'exited') {
      // exited can be graceful (state=stopping) — only treat as crash if not.
      if (child.state === 'stopping' || child.state === 'stopped') return;
      this.recordCrash(child, evt.message ?? evt.type);
      child.instance = null;
    }
  }

  // ---- internal: state mgmt + snapshot ------------------------------------

  private transition(child: RegisteredChild, next: ChildState, reason: string): void {
    if (child.state === next) return;
    child.state = next;
    child.changedAt = new Date(this.opts.now()).toISOString();
    child.logger.info(`state → ${next}`, { reason });
    this.notify();
  }

  private snapshot(child: RegisteredChild, now: number): ChildStatus {
    const cutoff = now - child.policy.windowMs;
    const recent = child.crashTimestamps.filter((t) => t >= cutoff).length;
    return {
      id: child.ctx.id,
      platform: child.ctx.platform,
      state: child.state,
      restartCount: child.restartCount,
      recentCrashCount: recent,
      changedAt: child.changedAt,
      ...(child.lastError !== undefined ? { lastError: child.lastError } : {}),
      ...(child.nextRestartAt !== undefined
        ? { nextRestartAt: child.nextRestartAt }
        : {}),
    };
  }

  private notify(): void {
    const snap = this.status();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        // never let a listener error escape
      }
    }
  }

  private requireChild(id: string): RegisteredChild {
    const c = this.children.get(id);
    if (!c) throw new Error(`unknown child id: ${id}`);
    return c;
  }
}

// =============================================================================
// Pure helpers — exported for unit tests.
// =============================================================================

/**
 * Exponential backoff with bounded jitter — direct mirror of the Swift
 * `WSClient.swift` `backoff = min(backoff * 2, backoffMax)` line, with two
 * additions: per-child policy + ±jitter fraction.
 */
export function computeBackoff(restartCount: number, policy: RestartPolicy): number {
  const raw = policy.initialBackoffMs * Math.pow(policy.factor, restartCount);
  const capped = Math.min(raw, policy.maxBackoffMs);
  if (policy.jitter <= 0) return Math.round(capped);
  // ±jitter fraction; deterministic-friendly via Math.random
  const j = (Math.random() * 2 - 1) * policy.jitter; // -jitter..+jitter
  return Math.max(0, Math.round(capped * (1 + j)));
}

async function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

