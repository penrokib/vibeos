// =============================================================================
// base-child.test.ts
// -----------------------------------------------------------------------------
// Sanity-checks the child registry + the NoOpChild reference impl. M04+ rely
// on this contract; locking it down here prevents silent drift.
// =============================================================================

import {
  __resetChildRegistryForTests,
  getChildFactory,
  listRegisteredPlatforms,
  registerChildFactory,
} from '../base-child';
import { NoOpChild } from '../noop-child';

afterEach(() => {
  __resetChildRegistryForTests();
});

describe('child registry', () => {
  it('registers + retrieves a factory', async () => {
    registerChildFactory('noop', async (ctx) => new NoOpChild(ctx));
    expect(listRegisteredPlatforms()).toEqual(['noop']);
    const f = getChildFactory('noop');
    expect(f).toBeDefined();
    const inst = await f!({ id: 'x', platform: 'noop' });
    expect(inst.id).toBe('x');
    expect(inst.platform).toBe('noop');
  });

  it('throws on duplicate registration', () => {
    registerChildFactory('noop', async (ctx) => new NoOpChild(ctx));
    expect(() =>
      registerChildFactory('noop', async (ctx) => new NoOpChild(ctx)),
    ).toThrow(/already registered/);
  });

  it('returns undefined for unknown platform', () => {
    expect(getChildFactory('whatsapp')).toBeUndefined();
  });
});

describe('NoOpChild', () => {
  it('lifecycle: start → running → stop → not running', async () => {
    const c = new NoOpChild({ id: 'n', platform: 'noop' });
    expect(c.isRunning()).toBe(false);
    await c.start();
    expect(c.isRunning()).toBe(true);
    await c.stop(true);
    expect(c.isRunning()).toBe(false);
  });

  it('emits a started event on start', async () => {
    const c = new NoOpChild({ id: 'n', platform: 'noop' });
    const events: string[] = [];
    c.onEvent((e) => events.push(e.type));
    await c.start();
    expect(events).toContain('started');
  });

  it('failOnStart: rejects start() and emits crashed', async () => {
    const c = new NoOpChild({ id: 'f', platform: 'noop' }, { failOnStart: true });
    const events: string[] = [];
    c.onEvent((e) => events.push(e.type));
    await expect(c.start()).rejects.toThrow();
    expect(events).toContain('crashed');
  });

  it('crashAfterStarts: succeeds N times, then crashes', async () => {
    const c = new NoOpChild(
      { id: 'c', platform: 'noop' },
      { crashAfterStarts: 2 },
    );
    await c.start();
    expect(c.isRunning()).toBe(true);
    await c.stop(true);
    await c.start();
    expect(c.isRunning()).toBe(true);
    await c.stop(true);
    // 3rd start should crash (startCount becomes 3 > 2)
    await expect(c.start()).rejects.toThrow();
  });

  it('health() returns {ok: running}', async () => {
    const c = new NoOpChild({ id: 'h', platform: 'noop' });
    expect((await c.health()).ok).toBe(false);
    await c.start();
    expect((await c.health()).ok).toBe(true);
  });

  it('handleSupervisorMessage shutdown stops the child', async () => {
    const c = new NoOpChild({ id: 'm', platform: 'noop' });
    await c.start();
    await c.handleSupervisorMessage({ kind: 'shutdown', graceful: true });
    expect(c.isRunning()).toBe(false);
  });
});
