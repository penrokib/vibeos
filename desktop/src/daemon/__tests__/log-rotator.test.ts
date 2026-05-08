// =============================================================================
// log-rotator.test.ts
// -----------------------------------------------------------------------------
// Smaller test for the rotating logger; rolls into one of the 6 mandated
// test files via the `__tests__` dir. Validates daily-rename behaviour with
// an injected clock.
// =============================================================================

import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildLogger, defaultLogDir } from '../log-rotator';

describe('ChildLogger', () => {
  it('writes JSONL records to <dir>/daemon-<id>.log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rokibrain-log-'));
    const log = new ChildLogger('alpha', dir);
    await log.open();
    log.info('hello', { a: 1 });
    log.warn('careful');
    await log.close();

    const file = join(dir, 'daemon-alpha.log');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf8');
    const lines = content.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'hello', childId: 'alpha' });
    expect(lines[0].data).toEqual({ a: 1 });
    expect(lines[1].level).toBe('warn');
  });

  it('rotates on day boundary with archived filename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rokibrain-log-'));
    let day = new Date('2026-05-07T12:00:00Z');
    const log = new ChildLogger('rotor', dir, () => day);
    await log.open();
    log.info('day1');
    // give the writeStream a tick to actually create the file on disk
    await new Promise((r) => setTimeout(r, 20));
    // advance one day
    day = new Date('2026-05-08T12:00:00Z');
    log.info('day2');
    await new Promise((r) => setTimeout(r, 20));
    await log.close();

    const files = readdirSync(dir);
    expect(files).toContain('daemon-rotor.log');
    expect(files.some((f) => f === 'daemon-rotor.2026-05-07.log')).toBe(true);
  });

  it('defaultLogDir() returns a platform-appropriate path', () => {
    const d = defaultLogDir();
    expect(typeof d).toBe('string');
    expect(d.length).toBeGreaterThan(0);
  });
});
