// =============================================================================
// supervisor.test.ts
// -----------------------------------------------------------------------------
// Covers:
//   - circuit-breaker fires after maxCrashesInWindow crashes inside windowMs
//   - exponential backoff sequence matches expectation (jitter=0)
//   - graceful shutdown paths
//   - emergencyStop / resume
//   - unlock() restores a permanently-failed child
// =============================================================================

import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { computeBackoff, Supervisor } from '../supervisor';
import { NoOpChild } from '../noop-child';
import {
  DEFAULT_RESTART_POLICY,
  type RestartPolicy,
} from '../types';
import type { ChildContext } from '../base-child';

function makeCtx(id: string, override: Partial<ChildContext> = {}): ChildContext {
  return {
    id,
    platform: 'noop',
    ...override,
  };
}

function freshSupervisor(): Supervisor {
  return new Supervisor({
    disableTimers: true,
    logDir: mkdtempSync(join(tmpdir(), 'rokibrain-test-')),
    defaultRestartPolicy: { jitter: 0 },
  });
}

describe('Supervisor: circuit breaker', () => {
  it('trips to permanently-failed after maxCrashesInWindow + 1 crashes', async () => {
    const sup = freshSupervisor();
    sup.register(makeCtx('failing'), async (ctx) => new NoOpChild(ctx, { failOnStart: true }));

    // Default policy: maxCrashesInWindow=5. We need 6 crashes to trip.
    for (let i = 0; i < 6; i++) {
      // start() will throw via failOnStart; supervisor records crash internally
      await sup.start('failing');
    }

    const status = sup.status();
    const child = status.children.find((c) => c.id === 'failing');
    expect(child?.state).toBe('permanently-failed');
    expect(child?.recentCrashCount).toBeGreaterThanOrEqual(6);
  });

  it('does NOT trip if crashes are below threshold', async () => {
    const sup = freshSupervisor();
    sup.register(makeCtx('flaky'), async (ctx) => new NoOpChild(ctx, { failOnStart: true }));

    // 3 crashes — below 5 threshold (uses > maxCrashesInWindow logic).
    for (let i = 0; i < 3; i++) {
      await sup.start('flaky');
    }

    const status = sup.status();
    const child = status.children.find((c) => c.id === 'flaky');
    expect(child?.state).toBe('crashing');
    expect(child?.state).not.toBe('permanently-failed');
  });

  it('refuses to start a permanently-failed child until unlock()', async () => {
    const sup = freshSupervisor();
    sup.register(makeCtx('borked'), async (ctx) => new NoOpChild(ctx, { failOnStart: true }));

    for (let i = 0; i < 6; i++) await sup.start('borked');

    await expect(sup.start('borked')).rejects.toThrow(/permanently-failed/);

    sup.unlock('borked');
    const status = sup.status();
    const child = status.children.find((c) => c.id === 'borked');
    expect(child?.state).toBe('idle');
  });

  it('crash window trims old timestamps so breaker only fires on recent burst', async () => {
    let now = 1_000_000;
    const sup = new Supervisor({
      disableTimers: true,
      logDir: mkdtempSync(join(tmpdir(), 'rokibrain-test-')),
      now: () => now,
      defaultRestartPolicy: { jitter: 0, windowMs: 1000 },
    });
    sup.register(makeCtx('windowed'), async (ctx) => new NoOpChild(ctx, { failOnStart: true }));

    // 5 crashes inside the window — trips? threshold is "> 5", so 6 would trip.
    for (let i = 0; i < 5; i++) {
      await sup.start('windowed');
      now += 100; // advance 100ms; all stay inside the 1000ms window
    }
    // Move past the window; older crashes drop out.
    now += 5_000;
    await sup.start('windowed'); // 1 fresh crash, others trimmed
    const status = sup.status();
    const child = status.children.find((c) => c.id === 'windowed');
    expect(child?.state).not.toBe('permanently-failed');
    expect(child?.recentCrashCount).toBeLessThanOrEqual(1);
  });
});

describe('computeBackoff', () => {
  const policy: RestartPolicy = { ...DEFAULT_RESTART_POLICY, jitter: 0 };

  it('starts at initialBackoffMs', () => {
    expect(computeBackoff(0, policy)).toBe(policy.initialBackoffMs);
  });

  it('doubles each step up to the max', () => {
    expect(computeBackoff(1, policy)).toBe(policy.initialBackoffMs * 2);
    expect(computeBackoff(2, policy)).toBe(policy.initialBackoffMs * 4);
    expect(computeBackoff(3, policy)).toBe(policy.initialBackoffMs * 8);
  });

  it('caps at maxBackoffMs', () => {
    // 1s, factor 2: step n where 1000 * 2^n > 5*60*1000 → n>=9
    expect(computeBackoff(20, policy)).toBe(policy.maxBackoffMs);
    expect(computeBackoff(50, policy)).toBe(policy.maxBackoffMs);
  });

  it('respects custom factor + initial', () => {
    const custom: RestartPolicy = {
      ...DEFAULT_RESTART_POLICY,
      jitter: 0,
      initialBackoffMs: 500,
      factor: 3,
    };
    expect(computeBackoff(0, custom)).toBe(500);
    expect(computeBackoff(1, custom)).toBe(1500);
    expect(computeBackoff(2, custom)).toBe(4500);
  });

  it('jitter is bounded by ±jitter fraction', () => {
    const j: RestartPolicy = { ...DEFAULT_RESTART_POLICY, jitter: 0.2 };
    for (let i = 0; i < 100; i++) {
      const v = computeBackoff(0, j);
      expect(v).toBeGreaterThanOrEqual(800); // 1000 * (1 - 0.2)
      expect(v).toBeLessThanOrEqual(1200);
    }
  });
});

describe('Supervisor: lifecycle', () => {
  it('start → running → stop(graceful) → stopped', async () => {
    const sup = freshSupervisor();
    sup.register(makeCtx('a'), async (ctx) => new NoOpChild(ctx));

    await sup.start('a');
    expect(sup.status().children[0].state).toBe('running');

    await sup.stop('a', true);
    expect(sup.status().children[0].state).toBe('stopped');
  });

  it('emergencyStop transitions all children to paused and refuses startAll', async () => {
    const sup = freshSupervisor();
    sup.register(makeCtx('a'), async (ctx) => new NoOpChild(ctx));
    sup.register(makeCtx('b'), async (ctx) => new NoOpChild(ctx));
    await sup.startAll();

    await sup.emergencyStop();
    const states = sup.status().children.map((c) => c.state);
    expect(states.every((s) => s === 'paused')).toBe(true);
    expect(sup.status().emergencyStopped).toBe(true);

    await expect(sup.startAll()).rejects.toThrow(/emergency-stopped/);
  });

  it('resume after emergencyStop allows startAll again', async () => {
    const sup = freshSupervisor();
    sup.register(makeCtx('a'), async (ctx) => new NoOpChild(ctx));
    await sup.startAll();
    await sup.emergencyStop();
    sup.resume();
    expect(sup.status().emergencyStopped).toBe(false);
    expect(sup.status().children[0].state).toBe('idle');

    await sup.startAll();
    expect(sup.status().children[0].state).toBe('running');
  });

  it('status snapshot includes wsPort + uptime + children list', async () => {
    const sup = freshSupervisor();
    sup.setWsPort(45123);
    sup.register(makeCtx('a'), async (ctx) => new NoOpChild(ctx));
    await sup.start('a');

    const s = sup.status();
    expect(s.wsPort).toBe(45123);
    expect(typeof s.uptime).toBe('number');
    expect(s.children).toHaveLength(1);
    expect(s.children[0]).toMatchObject({
      id: 'a',
      platform: 'noop',
      state: 'running',
    });
  });
});
