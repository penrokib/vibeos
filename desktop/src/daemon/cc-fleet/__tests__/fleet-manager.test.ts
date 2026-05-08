// =============================================================================
// fleet-manager.test.ts
// -----------------------------------------------------------------------------
// Jest unit tests for FleetManager.
// All subprocess spawning is mocked — no real `claude` binary is invoked.
// =============================================================================

import { FleetManager } from '../fleet-manager';
import type { CCAccount, CCJob } from '../cc-fleet.types';

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------
// We mock at the module level so that both the `which claude` probe and the
// actual `claude --print` call can be controlled per-test.
// ---------------------------------------------------------------------------

type MockSpawnFn = jest.Mock;

const mockSpawnFn: MockSpawnFn = jest.fn();

jest.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawnFn(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake EventEmitter-like mock for spawn('which', ['claude']). */
function makeWhichSuccess(): ReturnType<typeof mockSpawnFn> {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const proc = {
    on: (event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return proc;
    },
    stdout: null,
    stderr: null,
    _emit(event: string, ...args: unknown[]) {
      (listeners[event] ?? []).forEach((fn) => fn(...args));
    },
  };
  // Simulate synchronous resolution via setTimeout(0).
  setTimeout(() => proc._emit('close', 0), 0);
  return proc;
}

function makeWhichFailure(): ReturnType<typeof mockSpawnFn> {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const proc = {
    on: (event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return proc;
    },
    stdout: null,
    stderr: null,
    _emit(event: string, ...args: unknown[]) {
      (listeners[event] ?? []).forEach((fn) => fn(...args));
    },
  };
  setTimeout(() => proc._emit('close', 1), 0);
  return proc;
}

interface MockedProcess {
  on: jest.Mock;
  stdout: { on: jest.Mock };
  stderr: { on: jest.Mock };
  _resolveWith(output: string): void;
  _rejectWith(code: number, errMsg: string): void;
}

/** Build a fake spawn process for claude --print. */
function makeClaudeProcess(output = 'mock output'): MockedProcess {
  type Listener = (...args: unknown[]) => void;
  const listeners: Record<string, Listener[]> = {};
  const stdoutListeners: Record<string, Listener[]> = {};
  const stderrListeners: Record<string, Listener[]> = {};

  const proc: MockedProcess = {
    on: jest.fn((event: string, cb: Listener) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return proc;
    }) as jest.Mock,
    stdout: {
      on: jest.fn((event: string, cb: Listener) => {
        stdoutListeners[event] = stdoutListeners[event] ?? [];
        stdoutListeners[event].push(cb);
      }) as jest.Mock,
    },
    stderr: {
      on: jest.fn((event: string, cb: Listener) => {
        stderrListeners[event] = stderrListeners[event] ?? [];
        stderrListeners[event].push(cb);
      }) as jest.Mock,
    },
    _resolveWith(out: string) {
      (stdoutListeners['data'] ?? []).forEach((fn) =>
        fn(Buffer.from(out, 'utf8')),
      );
      (listeners['close'] ?? []).forEach((fn) => fn(0));
    },
    _rejectWith(code: number, errMsg: string) {
      (stderrListeners['data'] ?? []).forEach((fn) =>
        fn(Buffer.from(errMsg, 'utf8')),
      );
      (listeners['close'] ?? []).forEach((fn) => fn(code));
    },
  };
  void output; // suppress lint; actual use is in _resolveWith
  return proc;
}

function makeAccount(
  id: string,
  overrides: Partial<CCAccount> = {},
): CCAccount {
  return {
    id,
    concurrencyMax: 1,
    tokensUsed5h: 0,
    lastResetAt: Date.now(),
    status: 'idle',
    ...overrides,
  };
}

function makeJob(id: string, overrides: Partial<CCJob> = {}): CCJob {
  return { id, prompt: `test prompt ${id}`, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FleetManager: round-robin account selection', () => {
  let fm: FleetManager;

  beforeEach(() => {
    jest.clearAllMocks();
    fm = new FleetManager();
  });

  afterEach(() => {
    fm.destroy();
  });

  it('picks accounts in round-robin order across sequential submits', async () => {
    const acc1 = makeAccount('acc1');
    const acc2 = makeAccount('acc2');
    fm.register(acc1);
    fm.register(acc2);

    const usedAccounts: string[] = [];

    // We'll intercept spawn calls: first 'which' resolves, then 'claude'.
    mockSpawnFn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeWhichSuccess();
      const cp = makeClaudeProcess();
      setTimeout(() => cp._resolveWith('ok'), 0);
      return cp;
    });

    const j1 = fm.submit(makeJob('j1'));
    const r1 = await j1;
    usedAccounts.push(r1.account);

    const j2 = fm.submit(makeJob('j2'));
    const r2 = await j2;
    usedAccounts.push(r2.account);

    // Two distinct accounts should have been picked (round-robin).
    expect(usedAccounts).toHaveLength(2);
    expect(new Set(usedAccounts).size).toBe(2);
  });
});

describe('FleetManager: rate-limited account skipped', () => {
  let fm: FleetManager;

  beforeEach(() => {
    jest.clearAllMocks();
    fm = new FleetManager();
  });

  afterEach(() => {
    fm.destroy();
  });

  it('skips the rate-limited account and uses the other one', async () => {
    const acc1 = makeAccount('acc1');
    const acc2 = makeAccount('acc2');
    fm.register(acc1);
    fm.register(acc2);

    // Mark acc1 as rate-limited far in the future.
    fm.markRateLimited('acc1', Date.now() + 60_000 * 60);

    mockSpawnFn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeWhichSuccess();
      const cp = makeClaudeProcess();
      setTimeout(() => cp._resolveWith('ok'), 0);
      return cp;
    });

    const result = await fm.submit(makeJob('j1'));
    expect(result.account).toBe('acc2');
  });
});

describe('FleetManager: 5h reset clears rate limit', () => {
  let fm: FleetManager;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    fm = new FleetManager();
  });

  afterEach(() => {
    fm.destroy();
    jest.useRealTimers();
  });

  it('resets tokensUsed5h and restores idle status after 5h window', () => {
    const acc = makeAccount('acc1', {
      tokensUsed5h: 99_000,
      lastResetAt: Date.now() - (5 * 60 * 60 * 1_000 + 1_000), // 5h+1s ago
    });
    fm.register(acc);

    // Advance 61 seconds so the 1-min reset timer fires.
    jest.advanceTimersByTime(61_000);

    const [listed] = fm.list();
    expect(listed?.tokensUsed5h).toBe(0);
    expect(listed?.status).toBe('idle');
  });
});

describe('FleetManager: per-account concurrency cap', () => {
  let fm: FleetManager;

  beforeEach(() => {
    jest.clearAllMocks();
    fm = new FleetManager();
  });

  afterEach(() => {
    fm.destroy();
  });

  it('enforces concurrencyMax=1 — 3rd job waits for a slot', async () => {
    // Use concurrencyMax=1 so the test reliably serialises jobs.
    const acc = makeAccount('acc1', { concurrencyMax: 1 });
    fm.register(acc);

    const order: string[] = [];
    const resolvers: Array<() => void> = [];

    mockSpawnFn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeWhichSuccess();
      const cp = makeClaudeProcess();
      resolvers.push(() => cp._resolveWith('done'));
      return cp;
    });

    // Helper: wait for a resolver to appear (polls with small delay).
    const waitForResolver = async (idx: number): Promise<void> => {
      let n = 0;
      while (resolvers.length <= idx && n < 100) {
        await new Promise<void>((res) => setTimeout(res, 5));
        n++;
      }
    };

    const p1 = fm.submit(makeJob('j1', { account: 'acc1' })).then((r) => {
      order.push(r.jobId);
      return r;
    });
    const p2 = fm.submit(makeJob('j2', { account: 'acc1' })).then((r) => {
      order.push(r.jobId);
      return r;
    });
    const p3 = fm.submit(makeJob('j3', { account: 'acc1' })).then((r) => {
      order.push(r.jobId);
      return r;
    });

    // j1's which probe fires → j1 acquires slot → spawns claude.
    await waitForResolver(0);
    expect(resolvers).toHaveLength(1); // only j1 running

    // Resolve j1 → releases slot → j2 acquires.
    resolvers[0]?.();
    await p1;
    await waitForResolver(1);
    expect(resolvers).toHaveLength(2);

    // Resolve j2 → j3 acquires.
    resolvers[1]?.();
    await p2;
    await waitForResolver(2);
    expect(resolvers).toHaveLength(3);

    resolvers[2]?.();
    await p3;

    // All 3 completed in serial order (cap=1 enforced).
    expect(order).toEqual(['j1', 'j2', 'j3']);
  });
});

describe('FleetManager: CC_NOT_INSTALLED graceful path', () => {
  let fm: FleetManager;

  beforeEach(() => {
    jest.clearAllMocks();
    fm = new FleetManager();
  });

  afterEach(() => {
    fm.destroy();
  });

  it('returns CC_NOT_INSTALLED when which claude fails', async () => {
    fm.register(makeAccount('acc1'));

    mockSpawnFn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeWhichFailure();
      // Should never reach here.
      return makeClaudeProcess();
    });

    const result = await fm.submit(makeJob('j1'));
    expect(result.output).toContain('CC_NOT_INSTALLED');
    expect(result.jobId).toBe('j1');
  });
});

describe('FleetManager: 5+ parallel submits concurrency safety', () => {
  let fm: FleetManager;

  beforeEach(() => {
    jest.clearAllMocks();
    fm = new FleetManager();
  });

  afterEach(() => {
    fm.destroy();
  });

  it('never exceeds concurrencyMax=1 under 5 simultaneous submits (concurrency-safety)', async () => {
    // concurrencyMax=1 forces strict serialisation, making the invariant easy to verify.
    const acc = makeAccount('acc1', { concurrencyMax: 1 });
    fm.register(acc);

    const resolvers: Array<() => void> = [];
    let maxSimultaneous = 0;
    let active = 0;

    mockSpawnFn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeWhichSuccess();
      active++;
      maxSimultaneous = Math.max(maxSimultaneous, active);
      const cp = makeClaudeProcess();
      resolvers.push(() => {
        active--;
        cp._resolveWith('ok');
      });
      return cp;
    });

    const waitForResolver = async (idx: number): Promise<void> => {
      let n = 0;
      while (resolvers.length <= idx && n < 100) {
        await new Promise<void>((res) => setTimeout(res, 5));
        n++;
      }
    };

    const jobs = [1, 2, 3, 4, 5].map((n) =>
      fm.submit(makeJob(`j${n}`, { account: 'acc1' })),
    );

    // Release each subprocess one at a time in order.
    for (let i = 0; i < 5; i++) {
      await waitForResolver(i);
      resolvers[i]?.();
    }

    const results = await Promise.all(jobs);
    expect(results).toHaveLength(5);
    results.forEach((r) => expect(r.account).toBe('acc1'));
    // Critical: never exceeded cap of 1.
    expect(maxSimultaneous).toBeLessThanOrEqual(1);
  });
});
