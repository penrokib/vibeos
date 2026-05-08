// =============================================================================
// rokibrain.app — FleetManager (CC Fleet)
// -----------------------------------------------------------------------------
// Manages a pool of Claude Code subprocesses across multiple Anthropic accounts.
//
// Design rules (hard walls from memory):
//   - Per-account concurrency cap is MANDATORY (feedback-anthropic-rolling-budget).
//     Default = 1; never exceed account.concurrencyMax.
//   - API keys are NEVER stored in code or logs. Read from env at spawn time.
//   - 5h rolling token window: resets per account based on lastResetAt.
//   - Rate-limited accounts are skipped; queue routes to next available.
//   - Graceful degrade: if `claude` binary is not in PATH, return
//     CC_NOT_INSTALLED message instead of throwing.
// =============================================================================

import { spawn } from 'node:child_process';
import { type CCAccount, type CCJob, type CCResult } from './cc-fleet.types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const RESET_INTERVAL_MS = 60_000; // check every minute

// ---------------------------------------------------------------------------
// Internal per-account runtime state
// ---------------------------------------------------------------------------
interface AccountRuntime {
  account: CCAccount;
  /** Number of CC subprocesses currently running for this account. */
  activeConcurrency: number;
  /** Queue of pending submitters waiting for a concurrency slot. */
  waitQueue: Array<() => void>;
}

// ---------------------------------------------------------------------------
// FleetManager
// ---------------------------------------------------------------------------

export class FleetManager {
  private readonly accounts = new Map<string, AccountRuntime>();
  private roundRobinIndex = 0;
  private resetTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startResetTimer();
  }

  // ---- public API ----------------------------------------------------------

  /** Register a new account. Idempotent: re-registering replaces the old entry. */
  register(account: CCAccount): void {
    const existing = this.accounts.get(account.id);
    if (existing) {
      // Update fields but preserve runtime concurrency tracking.
      existing.account = { ...account };
    } else {
      this.accounts.set(account.id, {
        account: { ...account },
        activeConcurrency: 0,
        waitQueue: [],
      });
    }
  }

  /** Remove an account. In-flight jobs for this account are not cancelled. */
  unregister(id: string): void {
    this.accounts.delete(id);
  }

  /** Returns a snapshot of all registered accounts (cloned, safe to mutate). */
  list(): CCAccount[] {
    return Array.from(this.accounts.values()).map((r) => ({ ...r.account }));
  }

  /**
   * Submit a job. Picks the next eligible account (round-robin over non-rate-
   * limited entries), waits for a concurrency slot, then spawns a CC subprocess.
   *
   * If `job.account` is set, forces that specific account (still respects cap).
   * If `claude` is not in PATH, returns a CC_NOT_INSTALLED result immediately.
   */
  async submit(job: CCJob): Promise<CCResult> {
    const start = Date.now();

    // Check claude binary availability first (graceful degrade).
    const ccAvailable = await this.isClaudeAvailable();
    if (!ccAvailable) {
      const accountId = job.account ?? this.pickAccount()?.account.id ?? 'none';
      return {
        jobId: job.id,
        account: accountId,
        output: "CC_NOT_INSTALLED — install via `brew install claude-code`",
        durationMs: Date.now() - start,
      };
    }

    // Pick account.
    const runtime = job.account
      ? this.accounts.get(job.account)
      : this.pickAccount();

    if (!runtime) {
      throw new Error('No eligible account available (all rate-limited or none registered).');
    }

    const account = runtime.account;

    // Wait for a concurrency slot.
    await this.acquireSlot(runtime);

    try {
      const output = await this.runClaude(account, job.prompt);
      // Rough token estimate: ~1 token per 4 chars (approximation for budget tracking).
      runtime.account.tokensUsed5h += Math.ceil(
        (job.prompt.length + output.length) / 4,
      );
      runtime.account.status =
        runtime.activeConcurrency > 0 ? 'busy' : 'idle';

      return {
        jobId: job.id,
        account: account.id,
        output,
        durationMs: Date.now() - start,
      };
    } finally {
      this.releaseSlot(runtime);
    }
  }

  /**
   * Mark an account as rate-limited until `untilTimestamp` (Unix ms).
   * Jobs will route to other eligible accounts.
   */
  markRateLimited(accountId: string, untilTimestamp: number): void {
    const runtime = this.accounts.get(accountId);
    if (!runtime) return;
    runtime.account.status = 'rate-limited';
    // Auto-clear the limit at the specified time.
    const delay = Math.max(0, untilTimestamp - Date.now());
    setTimeout(() => {
      const r = this.accounts.get(accountId);
      if (r && r.account.status === 'rate-limited') {
        r.account.status = r.activeConcurrency > 0 ? 'busy' : 'idle';
        // Drain any waiting jobs.
        this.drainWaitQueue(r);
      }
    }, delay);
  }

  /** Clean up internal timers. Call on shutdown. */
  destroy(): void {
    if (this.resetTimer !== null) {
      clearInterval(this.resetTimer);
      this.resetTimer = null;
    }
  }

  // ---- internal helpers ----------------------------------------------------

  /**
   * Start a 1-minute interval that resets tokensUsed5h for any account whose
   * lastResetAt is more than 5 hours ago.
   */
  private startResetTimer(): void {
    this.resetTimer = setInterval(() => {
      const now = Date.now();
      for (const runtime of this.accounts.values()) {
        if (now - runtime.account.lastResetAt >= FIVE_HOURS_MS) {
          runtime.account.tokensUsed5h = 0;
          runtime.account.lastResetAt = now;
          // Restore idle if it was only rate-limited due to budget.
          if (runtime.account.status === 'rate-limited') {
            runtime.account.status = runtime.activeConcurrency > 0 ? 'busy' : 'idle';
            this.drainWaitQueue(runtime);
          }
        }
      }
    }, RESET_INTERVAL_MS);

    // Don't block Node.js event loop shutdown.
    if (this.resetTimer.unref) {
      this.resetTimer.unref();
    }
  }

  /**
   * Round-robin selection: returns the next non-rate-limited account with
   * remaining concurrency headroom, or one that has headroom after queue drains.
   * Returns `undefined` if no eligible account exists.
   */
  private pickAccount(): AccountRuntime | undefined {
    const entries = Array.from(this.accounts.values());
    if (entries.length === 0) return undefined;

    const n = entries.length;
    for (let attempt = 0; attempt < n; attempt++) {
      const idx = this.roundRobinIndex % n;
      this.roundRobinIndex = (this.roundRobinIndex + 1) % n;
      const runtime = entries[idx];
      if (runtime && runtime.account.status !== 'rate-limited') {
        return runtime;
      }
    }
    return undefined; // all rate-limited
  }

  /**
   * Acquire a concurrency slot for the given account runtime.
   * If at capacity, enqueue a waiter promise that resolves when a slot frees.
   */
  private acquireSlot(runtime: AccountRuntime): Promise<void> {
    if (runtime.activeConcurrency < runtime.account.concurrencyMax) {
      runtime.activeConcurrency++;
      runtime.account.status = 'busy';
      return Promise.resolve();
    }
    // At capacity — enqueue.
    return new Promise<void>((resolve) => {
      runtime.waitQueue.push(() => {
        runtime.activeConcurrency++;
        runtime.account.status = 'busy';
        resolve();
      });
    });
  }

  /** Release a concurrency slot and unblock the next waiter if any. */
  private releaseSlot(runtime: AccountRuntime): void {
    runtime.activeConcurrency = Math.max(0, runtime.activeConcurrency - 1);
    this.drainWaitQueue(runtime);
  }

  /** Pop and invoke next waiter if concurrency headroom allows. */
  private drainWaitQueue(runtime: AccountRuntime): void {
    if (
      runtime.waitQueue.length > 0 &&
      runtime.activeConcurrency < runtime.account.concurrencyMax &&
      runtime.account.status !== 'rate-limited'
    ) {
      const next = runtime.waitQueue.shift();
      next?.();
    } else if (runtime.activeConcurrency === 0 && runtime.waitQueue.length === 0) {
      runtime.account.status = 'idle';
    }
  }

  /**
   * Probe whether `claude` is resolvable in PATH.
   * Uses `which` on Unix. Returns false gracefully on any error.
   */
  private isClaudeAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const probe = spawn('which', ['claude'], { stdio: 'ignore' });
        probe.on('close', (code) => resolve(code === 0));
        probe.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Run `claude code --print <prompt>` as a subprocess.
   * API key is read from process.env at spawn time — never stored in state.
   * Returns captured stdout.
   */
  private runClaude(account: CCAccount, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const keyEnvVar = `ANTHROPIC_API_KEY_${account.id.toUpperCase().replace(/-/g, '_')}`;
      const apiKey = process.env[keyEnvVar] ?? process.env['ANTHROPIC_API_KEY'] ?? '';

      // HARD WALL: never log the key value.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ANTHROPIC_API_KEY: apiKey,
      };

      const child = spawn('claude', ['--print', prompt], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));

      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks).toString('utf8').trim());
        } else {
          const errMsg = Buffer.concat(errChunks).toString('utf8').trim();
          reject(new Error(`claude exited with code ${code}: ${errMsg}`));
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }
}
