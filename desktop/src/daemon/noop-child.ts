// =============================================================================
// rokibrain.app — NoOpChild (M02)
// -----------------------------------------------------------------------------
// Test/integration impl of BaseMeshChild. Pretends to spawn, emits a 'started'
// event, and reports health=ok. Used by the round-trip integration test and
// by the supervisor's smoke test until M04 wa-mesh ships.
//
// Public API surface kept deliberately small so M04 can model its own child
// after this without unintended dependencies.
// =============================================================================

import { BaseMeshChild, type ChildContext } from './base-child';
import type { HealthStatus, SupervisorMessage } from './types';

export interface NoOpChildOptions {
  /** When true, .start() throws — used to simulate startup crashes in tests. */
  failOnStart?: boolean;
  /** When set, .start() crashes after this many successful starts. */
  crashAfterStarts?: number;
  /** Synthetic latency for start/stop (ms) — defaults to 1ms. */
  latencyMs?: number;
}

export class NoOpChild extends BaseMeshChild {
  private running = false;
  private startCount = 0;
  private readonly opts: NoOpChildOptions;

  constructor(ctx: ChildContext, opts: NoOpChildOptions = {}) {
    super(ctx);
    this.opts = opts;
  }

  override async start(): Promise<void> {
    if (this.running) return;
    await sleep(this.opts.latencyMs ?? 1);
    this.startCount += 1;
    if (this.opts.failOnStart) {
      this.emit('crashed', { message: 'failOnStart=true' });
      throw new Error('NoOpChild: failOnStart=true');
    }
    if (
      this.opts.crashAfterStarts !== undefined &&
      this.startCount > this.opts.crashAfterStarts
    ) {
      this.emit('crashed', { message: `crashAfterStarts=${this.opts.crashAfterStarts}` });
      throw new Error('NoOpChild: synthetic crash');
    }
    this.running = true;
    this.emit('started');
  }

  override async stop(graceful: boolean): Promise<void> {
    if (!this.running) return;
    await sleep(this.opts.latencyMs ?? 1);
    this.running = false;
    this.emit('exited', { message: graceful ? 'graceful' : 'forced' });
  }

  override async health(): Promise<HealthStatus> {
    return {
      ok: this.running,
      detail: this.running ? 'noop running' : 'noop idle',
      metrics: { startCount: this.startCount },
    };
  }

  override async handleSupervisorMessage(msg: SupervisorMessage): Promise<void> {
    if (msg.kind === 'shutdown') {
      await this.stop(msg.graceful);
    }
    // Other kinds (init/pause/resume/health-probe) are no-ops in the noop.
  }

  /** Test introspection only. */
  isRunning(): boolean {
    return this.running;
  }
  getStartCount(): number {
    return this.startCount;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
