// =============================================================================
// digest-generator.test.ts
// -----------------------------------------------------------------------------
// Jest unit tests for DigestGenerator.
// FleetManager is fully mocked — no real CC subprocess is invoked.
// =============================================================================

import { DigestGenerator } from '../digest-generator';
import type { FleetManager } from '../../cc-fleet/fleet-manager';
import type { CCResult } from '../../cc-fleet/cc-fleet.types';
import type { RawSignal, SignalProvider } from '../digest.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFleet(output: string): jest.Mocked<Pick<FleetManager, 'submit'>> {
  const result: CCResult = {
    jobId: 'test-job',
    account: 'dewx',
    output,
    durationMs: 42,
  };
  return { submit: jest.fn().mockResolvedValue(result) };
}

const VALID_CC_OUTPUT = JSON.stringify({
  needsYou: [
    { id: 'n1', kind: 'decision', title: 'Approve billing copy change', subtitle: 'Blocked since 2h by maya persona', ts: Date.now() },
  ],
  whatHappened: [
    { id: 'w1', kind: 'alert', title: 'Deploy succeeded on beta server', subtitle: 'Commit 3f9a pushed 4h ago', ts: Date.now() - 14400000 },
  ],
  stuck: [
    { id: 's1', kind: 'persona', title: 'robert is idle over 4h', subtitle: 'Last seen enriching contacts list', ts: Date.now() - 14400000 },
  ],
});

const makeSignal = (overrides: Partial<RawSignal> = {}): RawSignal => ({
  draftCount: 0,
  decisionCount: 0,
  idlePersonas: [],
  recentAlertTitles: [],
  ...overrides,
});

const makeSignalProvider = (signal: RawSignal): SignalProvider => () => signal;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DigestGenerator', () => {
  describe('generate() — happy path', () => {
    it('returns a properly typed Digest with all required fields', async () => {
      const fleet = makeFleet(VALID_CC_OUTPUT) as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('work');

      expect(digest.id).toBeTruthy();
      expect(typeof digest.id).toBe('string');
      expect(digest.mode).toBe('work');
      expect(typeof digest.generatedAt).toBe('number');
      expect(Array.isArray(digest.needsYou)).toBe(true);
      expect(Array.isArray(digest.whatHappened)).toBe(true);
      expect(Array.isArray(digest.stuck)).toBe(true);
    });

    it('preserves mode=work correctly', async () => {
      const fleet = makeFleet(VALID_CC_OUTPUT) as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('work');

      expect(digest.mode).toBe('work');
    });

    it('preserves mode=personal correctly', async () => {
      const fleet = makeFleet(VALID_CC_OUTPUT) as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('personal');

      expect(digest.mode).toBe('personal');
    });

    it('submits via FleetManager.submit (not raw spawn)', async () => {
      const fleet = makeFleet(VALID_CC_OUTPUT) as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      await gen.generate('work');

      expect((fleet as unknown as { submit: jest.Mock }).submit).toHaveBeenCalledTimes(1);
      const call = (fleet as unknown as { submit: jest.Mock }).submit.mock.calls[0][0];
      expect(call.prompt).toBeTruthy();
      expect(call.id).toBeTruthy();
    });

    it('parses CC items with expected DigestItem shape', async () => {
      const fleet = makeFleet(VALID_CC_OUTPUT) as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('work');

      expect(digest.needsYou[0]).toMatchObject({
        id: 'n1',
        kind: 'decision',
        title: expect.stringMatching(/\w+/),
      });
    });
  });

  describe('generate() — fallback to template digest', () => {
    it('returns template digest (no throw) when CC output is malformed JSON', async () => {
      const fleet = makeFleet('this is not json at all') as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('work');

      expect(digest).toBeDefined();
      expect(digest.mode).toBe('work');
      // Template digest always returns valid Digest — arrays are present.
      expect(Array.isArray(digest.needsYou)).toBe(true);
    });

    it('returns template digest (no throw) when CC output is CC_NOT_INSTALLED', async () => {
      const fleet = makeFleet('CC_NOT_INSTALLED — install via `brew install claude-code`') as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('work');

      expect(digest).toBeDefined();
      expect(digest.mode).toBe('work');
    });

    it('returns template digest (no throw) when FleetManager.submit throws', async () => {
      const fleet = {
        submit: jest.fn().mockRejectedValue(new Error('No eligible account available')),
      } as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('personal');

      expect(digest).toBeDefined();
      expect(digest.mode).toBe('personal');
    });

    it('template digest includes decision item when signal has pending decisions', async () => {
      const fleet = makeFleet('bad json') as unknown as FleetManager;
      const signal = makeSignal({ decisionCount: 3 });
      const gen = new DigestGenerator(fleet, makeSignalProvider(signal));

      const digest = await gen.generate('work');

      const hasDecision = digest.needsYou.some((i) => i.kind === 'decision');
      expect(hasDecision).toBe(true);
      expect(digest.needsYou[0]?.title).toMatch(/3 decision/);
    });

    it('template digest includes draft item when signal has queued drafts', async () => {
      const fleet = makeFleet('bad json') as unknown as FleetManager;
      const signal = makeSignal({ draftCount: 5 });
      const gen = new DigestGenerator(fleet, makeSignalProvider(signal));

      const digest = await gen.generate('work');

      const hasDraft = digest.needsYou.some((i) => i.kind === 'draft');
      expect(hasDraft).toBe(true);
    });

    it('template digest populates stuck from idlePersonas', async () => {
      const fleet = makeFleet('bad json') as unknown as FleetManager;
      const signal = makeSignal({ idlePersonas: ['maya', 'robert'] });
      const gen = new DigestGenerator(fleet, makeSignalProvider(signal));

      const digest = await gen.generate('work');

      expect(digest.stuck).toHaveLength(2);
      expect(digest.stuck[0]?.kind).toBe('persona');
    });
  });

  describe('tenant isolation — concurrent generates', () => {
    it('two concurrent generates produce independent Digests with distinct ids', async () => {
      const fleetA = makeFleet(VALID_CC_OUTPUT) as unknown as FleetManager;
      const fleetB = makeFleet(VALID_CC_OUTPUT) as unknown as FleetManager;
      const genA = new DigestGenerator(fleetA, makeSignalProvider(makeSignal({ draftCount: 1 })));
      const genB = new DigestGenerator(fleetB, makeSignalProvider(makeSignal({ draftCount: 9 })));

      const [digestA, digestB] = await Promise.all([
        genA.generate('work'),
        genB.generate('work'),
      ]);

      // Different generator instances with different signals — ids must be distinct.
      expect(digestA.id).not.toBe(digestB.id);
      // Fleet B should only have been called by genB.
      expect((fleetB as unknown as { submit: jest.Mock }).submit).toHaveBeenCalledTimes(1);
      expect((fleetA as unknown as { submit: jest.Mock }).submit).toHaveBeenCalledTimes(1);
    });
  });

  describe('SignalProvider DI hook', () => {
    it('accepts an async signalProvider and awaits it correctly', async () => {
      const fleet = makeFleet(VALID_CC_OUTPUT) as unknown as FleetManager;
      const asyncProvider: SignalProvider = () =>
        Promise.resolve(makeSignal({ decisionCount: 7 }));
      const gen = new DigestGenerator(fleet, asyncProvider);

      const digest = await gen.generate('work');

      // Even though the CC output is valid JSON, the prompt building should have
      // used the async signal. We just verify no error was thrown.
      expect(digest).toBeDefined();
    });

    it('can be replaced at construction time (DI contract for cycle 17)', async () => {
      const fleet = makeFleet('bad json') as unknown as FleetManager;
      const mockProvider = jest.fn().mockReturnValue(makeSignal({ draftCount: 2 }));
      const gen = new DigestGenerator(fleet, mockProvider);

      await gen.generate('personal');

      expect(mockProvider).toHaveBeenCalledTimes(1);
    });
  });

  describe('CC output edge cases', () => {
    it('strips markdown code fences from CC output before parsing', async () => {
      const fenced = '```json\n' + VALID_CC_OUTPUT + '\n```';
      const fleet = makeFleet(fenced) as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('work');

      // Should parse successfully and not fall back to template.
      expect(digest.needsYou[0]?.id).toBe('n1');
    });

    it('handles empty arrays from CC gracefully', async () => {
      const emptyOutput = JSON.stringify({ needsYou: [], whatHappened: [], stuck: [] });
      const fleet = makeFleet(emptyOutput) as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('work');

      expect(digest.needsYou).toHaveLength(0);
      expect(digest.whatHappened).toHaveLength(0);
      expect(digest.stuck).toHaveLength(0);
    });

    it('coerces unknown kind values to "alert"', async () => {
      const withBadKind = JSON.stringify({
        needsYou: [{ id: 'x1', kind: 'unknown-kind', title: 'Test item', ts: Date.now() }],
        whatHappened: [],
        stuck: [],
      });
      const fleet = makeFleet(withBadKind) as unknown as FleetManager;
      const gen = new DigestGenerator(fleet);

      const digest = await gen.generate('work');

      expect(digest.needsYou[0]?.kind).toBe('alert');
    });
  });
});
