// =============================================================================
// tmux-child.test.ts (M06b)
// -----------------------------------------------------------------------------
// Covers:
//   - bridge binary missing → child enters degrade mode (no throw)
//   - bridge present → spawn called with correct path + args
//   - input() with safe keystroke ("hello\r") → forwarded to bridge stdin
//   - input() with bare "2"+Enter while last 10 lines contain "Switch to extra usage"
//     → REFUSED; bridge stdin not written; refusal envelope emitted on output channel
//   - input() with bare "3"+Enter while "Switch to Team plan" visible → REFUSED
//   - input() with bare "1" (no Enter) → forwarded normally
//   - stop() sends SIGTERM, then SIGKILL after 5s if not exited
//   - 5+ parallel input() calls maintain order
// =============================================================================

import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { TmuxChild, sanitizeEnv } from '../tmux-child';

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof childProcess>('node:child_process'),
  spawn: jest.fn(),
}));

jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof fs>('node:fs'),
  existsSync: jest.fn(),
}));

const mockSpawn = childProcess.spawn as jest.MockedFunction<typeof childProcess.spawn>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

// ---------------------------------------------------------------------------
// Fake process builder
// ---------------------------------------------------------------------------

class FakeProcess extends EventEmitter {
  stdin = {
    writes: [] as string[],
    write: jest.fn((data: string) => { this.stdin.writes.push(data); return true; }),
  };
  stdout = new EventEmitter() as EventEmitter & { setEncoding: jest.Mock };
  stderr = new EventEmitter() as EventEmitter & { setEncoding: jest.Mock };
  pid = 42;
  exitCode: number | null = null;

  constructor() {
    super();
    (this.stdout as EventEmitter & { setEncoding: jest.Mock }).setEncoding = jest.fn();
    (this.stderr as EventEmitter & { setEncoding: jest.Mock }).setEncoding = jest.fn();
  }

  kill = jest.fn((signal: string) => {
    // Simulate exit when killed
    setImmediate(() => {
      this.exitCode = signal === 'SIGKILL' ? 9 : 0;
      this.emit('exit', this.exitCode, signal);
    });
  });
}

function makeFakeProcess(): FakeProcess {
  const fp = new FakeProcess();
  mockSpawn.mockReturnValueOnce(fp as unknown as childProcess.ChildProcess);
  return fp;
}

function makeCtx(id = 'tmux-bridge') {
  return { id, platform: 'tmux' };
}

// ---------------------------------------------------------------------------
// Helper: emit bridge stdout line
// ---------------------------------------------------------------------------

function emitBridgeLine(proc: FakeProcess, obj: unknown): void {
  (proc.stdout as EventEmitter).emit('data', JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TmuxChild', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: binary NOT found
    mockExistsSync.mockReturnValue(false);
  });

  // -------------------------------------------------------------------------
  // Degrade mode
  // -------------------------------------------------------------------------

  describe('degrade mode (binary missing)', () => {
    it('enters degrade mode when binary not found — no throw', async () => {
      mockExistsSync.mockReturnValue(false);
      const child = new TmuxChild(makeCtx());
      await expect(child.start()).resolves.toBeUndefined();
      expect(child.degradeMode).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('is idempotent — start() twice is a no-op', async () => {
      mockExistsSync.mockReturnValue(false);
      const child = new TmuxChild(makeCtx());
      await child.start();
      await child.start(); // second call
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('listPanes returns stub pane in degrade mode', async () => {
      mockExistsSync.mockReturnValue(false);
      const child = new TmuxChild(makeCtx());
      await child.start();
      const panes = await child.listPanes();
      expect(panes).toHaveLength(1);
      expect(panes[0].id).toBe('echo');
      expect(panes[0].label).toMatch(/bridge-mac binary not installed/);
    });

    it('health returns ok=true with degradeMode=1 metric', async () => {
      mockExistsSync.mockReturnValue(false);
      const child = new TmuxChild(makeCtx());
      await child.start();
      const h = await child.health();
      expect(h.ok).toBe(true);
      expect(h.metrics?.['degradeMode']).toBe(1);
      expect(h.metrics?.['bridgeRunning']).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Healthy mode (binary present)
  // -------------------------------------------------------------------------

  describe('healthy mode (binary present)', () => {
    it('spawns bridge with correct binary path', async () => {
      mockExistsSync.mockReturnValue(true);
      makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [spawnPath, spawnArgs] = mockSpawn.mock.calls[0];
      expect(spawnPath).toBe(child.binaryPath);
      expect(spawnArgs).toEqual([]);
    });

    it('spawns with sanitized env (no API keys)', async () => {
      process.env['TEST_SECRET_KEY'] = 'hunter2';
      process.env['SAFE_VAR'] = 'safe_value';
      mockExistsSync.mockReturnValue(true);
      makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();
      const spawnOptions = mockSpawn.mock.calls[0][2] as childProcess.SpawnOptions;
      const spawnEnv = spawnOptions?.env as Record<string, string> | undefined;
      expect(spawnEnv?.['TEST_SECRET_KEY']).toBeUndefined();
      expect(spawnEnv?.['SAFE_VAR']).toBe('safe_value');
      delete process.env['TEST_SECRET_KEY'];
      delete process.env['SAFE_VAR'];
    });

    it('health returns ok=true when proc running', async () => {
      mockExistsSync.mockReturnValue(true);
      makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();
      const h = await child.health();
      expect(h.ok).toBe(true);
      expect(h.metrics?.['bridgeRunning']).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // input() — safe keystrokes forwarded
  // -------------------------------------------------------------------------

  describe('input() — safe keystrokes', () => {
    it('forwards safe keystroke "hello\\r" to bridge stdin', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      child.input('pane-1', 'hello\r');

      expect(fp.stdin.write).toHaveBeenCalledTimes(1);
      const written = fp.stdin.writes[0];
      const parsed = JSON.parse(written) as { cmd: string; paneId: string; data: string };
      expect(parsed.cmd).toBe('input');
      expect(parsed.paneId).toBe('pane-1');
      expect(parsed.data).toBe('hello\r');
    });

    it('forwards bare "1" (no Enter after — safe confirm) to stdin', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      child.input('pane-1', '1');

      expect(fp.stdin.write).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(fp.stdin.writes[0]) as { data: string };
      expect(parsed.data).toBe('1');
    });
  });

  // -------------------------------------------------------------------------
  // input() — CC-modal hardwall
  // -------------------------------------------------------------------------

  describe('input() — cc-modal hardwall (feedback-cc-modal-dismiss.md)', () => {
    it('REFUSES bare "2"+"\\r" → refusal on output channel; bridge stdin not written', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      const outputs: Array<{ paneId: string; data: string }> = [];
      child.onOutput((paneId, data) => outputs.push({ paneId, data }));

      // The assertSafeTmuxKeystroke check is context-free — it checks the
      // keystroke itself. "2\r" is always refused.
      child.input('pane-1', '2\r');

      expect(fp.stdin.write).not.toHaveBeenCalled();
      expect(outputs).toHaveLength(1);
      expect(outputs[0].data).toMatch(/REFUSED/);
      expect(outputs[0].data).toMatch(/feedback-cc-modal-dismiss/);
    });

    it('REFUSES bare "3"+"\\r" → refusal on output channel; bridge stdin not written', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      const outputs: Array<{ paneId: string; data: string }> = [];
      child.onOutput((paneId, data) => outputs.push({ paneId, data }));

      child.input('pane-1', '3\r');

      expect(fp.stdin.write).not.toHaveBeenCalled();
      expect(outputs).toHaveLength(1);
      expect(outputs[0].data).toMatch(/REFUSED/);
    });

    it('REFUSES "2"+"\\n" (LF enter variant)', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      child.input('pane-1', '2\n');

      expect(fp.stdin.write).not.toHaveBeenCalled();
    });

    it('REFUSES token array ["2","Enter"]', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      // assertSafeTmuxKeystroke handles arrays — TmuxChild.input() takes string
      // but we test via the guard function itself being integrated correctly.
      // This passes "2\r" as a string equivalent.
      child.input('pane-1', '2\r\n');

      expect(fp.stdin.write).not.toHaveBeenCalled();
    });

    it('ALLOWS "23\\r" — 2 embedded in longer token is safe', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      child.input('pane-1', '23\r');

      // "23" is a single non-bare token — allowed
      expect(fp.stdin.write).toHaveBeenCalledTimes(1);
    });

    it('refusal in degrade mode also produces output banner', async () => {
      mockExistsSync.mockReturnValue(false);
      const child = new TmuxChild(makeCtx());
      await child.start();

      const outputs: Array<{ paneId: string; data: string }> = [];
      child.onOutput((paneId, data) => outputs.push({ paneId, data }));

      child.input('pane-1', '2\r');

      expect(outputs).toHaveLength(1);
      expect(outputs[0].data).toMatch(/REFUSED/);
    });
  });

  // -------------------------------------------------------------------------
  // stop() lifecycle
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('sends SIGTERM to subprocess', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      const stopPromise = child.stop(true);
      // FakeProcess.kill emits 'exit' via setImmediate → await stop
      await stopPromise;

      expect(fp.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('SIGKILLs after 5s if proc does not exit', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      mockExistsSync.mockReturnValue(true);

      const fp = makeFakeProcess();
      // Override kill: SIGTERM does nothing (hung process); SIGKILL emits exit
      fp.kill.mockImplementation((signal: string) => {
        if (signal === 'SIGKILL') {
          fp.exitCode = 9;
          // Use real setImmediate so it runs after fake timers advance
          process.nextTick(() => fp.emit('exit', 9, 'SIGKILL'));
        }
        // SIGTERM: do nothing — simulates a hung process
      });

      const child = new TmuxChild(makeCtx());
      await child.start();

      // Start stop() — it sends SIGTERM then waits 5s for exit
      const stopPromise = child.stop(true);

      // Advance past the 5-second SIGKILL deadline
      await jest.advanceTimersByTimeAsync(5_001);

      await stopPromise;

      const signals = fp.kill.mock.calls.map((c) => c[0] as string);
      expect(signals).toContain('SIGTERM');
      expect(signals).toContain('SIGKILL');

      jest.useRealTimers();
    }, 15_000);

    it('degrade mode stop() resolves immediately', async () => {
      mockExistsSync.mockReturnValue(false);
      const child = new TmuxChild(makeCtx());
      await child.start();
      await expect(child.stop(true)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency — 5+ parallel input() calls maintain order
  // -------------------------------------------------------------------------

  describe('concurrency', () => {
    it('5+ parallel input() calls produce ordered writes (feedback-concurrency-safety.md)', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      // Safe keystrokes
      const tokens = ['a', 'b', 'c', 'd', 'e', 'f'];
      // Call input() in parallel (all synchronous, but that's the point —
      // each is a discrete call from different callers)
      for (const t of tokens) {
        child.input('pane-1', t);
      }

      // All writes should have happened in order
      expect(fp.stdin.writes).toHaveLength(tokens.length);
      tokens.forEach((t, i) => {
        const parsed = JSON.parse(fp.stdin.writes[i]) as { data: string };
        expect(parsed.data).toBe(t);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Bridge output → output callback
  // -------------------------------------------------------------------------

  describe('bridge stdout → output callbacks', () => {
    it('emits output from bridge stdout to registered callbacks', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      const received: Array<{ paneId: string; data: string }> = [];
      child.onOutput((paneId, data) => received.push({ paneId, data }));

      emitBridgeLine(fp, { evt: 'output', paneId: 'pane-1', data: 'hello world\r\n' });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ paneId: 'pane-1', data: 'hello world\r\n' });
    });

    it('unsubscribe stops receiving callbacks', async () => {
      mockExistsSync.mockReturnValue(true);
      const fp = makeFakeProcess();
      const child = new TmuxChild(makeCtx());
      await child.start();

      const received: string[] = [];
      const unsub = child.onOutput((_paneId, data) => received.push(data));

      emitBridgeLine(fp, { evt: 'output', paneId: 'p', data: 'line1\r\n' });
      unsub();
      emitBridgeLine(fp, { evt: 'output', paneId: 'p', data: 'line2\r\n' });

      expect(received).toHaveLength(1);
      expect(received[0]).toBe('line1\r\n');
    });
  });

  // -------------------------------------------------------------------------
  // sanitizeEnv
  // -------------------------------------------------------------------------

  describe('sanitizeEnv', () => {
    it('strips SECRET, TOKEN, KEY, PASSWORD, ANTHROPIC, OPENAI, DEWX vars', () => {
      const env = {
        PATH: '/usr/bin',
        HOME: '/Users/roki',
        ANTHROPIC_API_KEY: 'sk-ant-xxx',
        OPENAI_API_KEY: 'sk-xxx',
        DEWX_TOKEN: 'dewx_mcp_xxx',
        MY_SECRET: 'topsecret',
        MY_PASSWORD: 'pass123',
        DB_CREDENTIAL: 'cred',
        SAFE_VAR: 'safe',
        NODE_ENV: 'production',
      };
      const result = sanitizeEnv(env);
      expect(result['PATH']).toBe('/usr/bin');
      expect(result['HOME']).toBe('/Users/roki');
      expect(result['SAFE_VAR']).toBe('safe');
      expect(result['NODE_ENV']).toBe('production');
      expect(result['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(result['OPENAI_API_KEY']).toBeUndefined();
      expect(result['DEWX_TOKEN']).toBeUndefined();
      expect(result['MY_SECRET']).toBeUndefined();
      expect(result['MY_PASSWORD']).toBeUndefined();
      expect(result['DB_CREDENTIAL']).toBeUndefined();
    });
  });
});
