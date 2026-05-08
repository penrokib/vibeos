// =============================================================================
// ComposePipeline — unit tests (Cycle 18)
// =============================================================================

import { ComposePipeline } from '../compose-pipeline';
import type { ComposeInput, ComposeResult, ComposeErrorResult } from '../compose-pipeline';
import type { FleetManager } from '../../cc-fleet/fleet-manager';
import type { Supervisor } from '../../supervisor';

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

function makeFleet(output: string | Error): jest.Mocked<Pick<FleetManager, 'submit'>> {
  return {
    submit: jest.fn().mockImplementation(() => {
      if (output instanceof Error) return Promise.reject(output);
      return Promise.resolve({
        jobId: 'job-1',
        account: 'test-account',
        output,
        durationMs: 10,
      });
    }),
  } as unknown as jest.Mocked<Pick<FleetManager, 'submit'>>;
}

function makeSupervisor(): Supervisor {
  return {} as Supervisor;
}

function makeFetch(draftId: string, ok = true): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve({ draftId }),
  });
}

const BASE_INPUT: ComposeInput = {
  account: 'wap',
  recipient: '+1234567890',
  persona: 'ceo',
  rawText: 'hey man want to catch up this week?',
  mode: 'work',
};

// Set env vars required by ComposePipeline BFF client before all tests.
beforeAll(() => {
  process.env['ROKIBRAIN_DEV_JWT'] = 'test-jwt-token';
  process.env['ROKIBRAIN_BFF_URL'] = 'http://localhost:3000';
});

afterAll(() => {
  delete process.env['ROKIBRAIN_DEV_JWT'];
  delete process.env['ROKIBRAIN_BFF_URL'];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComposePipeline', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it('happy path — CC returns valid JSON → posts draft → returns draftId', async () => {
    const fleet = makeFleet(
      JSON.stringify({ text: 'Hey — quick catch-up this week?', reasoning: 'Shortened for brevity' }),
    );
    const mockFetch = makeFetch('draft-abc-123');

    const pipeline = new ComposePipeline({
      fleet: fleet as unknown as FleetManager,
      supervisor: makeSupervisor(),
      fetchImpl: mockFetch,
    });

    const result = await pipeline.composeDraft(BASE_INPUT);

    expect('error' in result).toBe(false);
    const ok = result as ComposeResult;
    expect(ok.draftId).toBe('draft-abc-123');
    expect(ok.refinedText).toBe('Hey — quick catch-up this week?');
    expect(ok.reasoning).toBe('Shortened for brevity');

    // BFF was called exactly once — POST to /agency/drafts.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch('/agency/drafts');
    expect(init.method).toBe('POST');

    // Verify body has status:'pending' — NEVER auto-approve hardwall.
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['status']).toBe('pending');
  });

  // ── CC returns malformed JSON ───────────────────────────────────────────────

  it('CC malformed JSON → falls back to verbatim rawText; no throw', async () => {
    const fleet = makeFleet('not valid { json at all }}}');
    const mockFetch = makeFetch('draft-fallback');

    const pipeline = new ComposePipeline({
      fleet: fleet as unknown as FleetManager,
      supervisor: makeSupervisor(),
      fetchImpl: mockFetch,
    });

    const result = await pipeline.composeDraft(BASE_INPUT);

    expect('error' in result).toBe(false);
    const ok = result as ComposeResult;
    expect(ok.refinedText).toBe(BASE_INPUT.rawText);
    expect(ok.reasoning).toBe('CC parse failed; preserved input verbatim');
    expect(ok.draftId).toBe('draft-fallback');
  });

  // ── Account not paired (invalid chars) ────────────────────────────────────

  it('invalid account name → returns error envelope; no draft posted', async () => {
    const fleet = makeFleet('{}');
    const mockFetch = jest.fn();

    const pipeline = new ComposePipeline({
      fleet: fleet as unknown as FleetManager,
      supervisor: makeSupervisor(),
      fetchImpl: mockFetch,
    });

    const result = await pipeline.composeDraft({
      ...BASE_INPUT,
      account: '../../etc/passwd',
    });

    expect('error' in result).toBe(true);
    const err = result as ComposeErrorResult;
    expect(err.error).toBe('INVALID_ACCOUNT');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Persona registry miss ──────────────────────────────────────────────────

  it('unknown persona → CC prompt uses persona id as-is; does not throw', async () => {
    const fleet = makeFleet(
      JSON.stringify({ text: 'Hi there', reasoning: 'Casual tone' }),
    );
    const mockFetch = makeFetch('draft-unknown-persona');

    const pipeline = new ComposePipeline({
      fleet: fleet as unknown as FleetManager,
      supervisor: makeSupervisor(),
      fetchImpl: mockFetch,
    });

    // Persona not in any registry — just an unknown slug.
    const result = await pipeline.composeDraft({
      ...BASE_INPUT,
      persona: 'nonexistent-persona-xyz',
    });

    expect('error' in result).toBe(false);
    const ok = result as ComposeResult;
    expect(ok.refinedText).toBe('Hi there');
    // CC prompt includes the persona id — verify fleet received the right persona.
    expect((fleet.submit as jest.Mock).mock.calls[0][0].persona).toBe('nonexistent-persona-xyz');
  });

  // ── Target language auto-detection ────────────────────────────────────────

  it('Malaysian phone number → detects "ms" target language in prompt', async () => {
    const fleet = makeFleet(JSON.stringify({ text: 'Ok', reasoning: 'Short' }));
    const mockFetch = makeFetch('draft-lang');

    const pipeline = new ComposePipeline({
      fleet: fleet as unknown as FleetManager,
      supervisor: makeSupervisor(),
      fetchImpl: mockFetch,
    });

    await pipeline.composeDraft({
      ...BASE_INPUT,
      recipient: '+60123456789', // Malaysian number
    });

    const submittedPrompt = (fleet.submit as jest.Mock).mock.calls[0][0].prompt as string;
    expect(submittedPrompt).toContain('Target language: ms');
  });

  it('English phone number → detects "en" target language by default', async () => {
    const fleet = makeFleet(JSON.stringify({ text: 'Hello', reasoning: 'Formal' }));
    const mockFetch = makeFetch('draft-en');

    const pipeline = new ComposePipeline({
      fleet: fleet as unknown as FleetManager,
      supervisor: makeSupervisor(),
      fetchImpl: mockFetch,
    });

    await pipeline.composeDraft({
      ...BASE_INPUT,
      recipient: '+447890123456', // UK number
    });

    const submittedPrompt = (fleet.submit as jest.Mock).mock.calls[0][0].prompt as string;
    expect(submittedPrompt).toContain('Target language: en');
  });

  // ── NEVER auto-approve ─────────────────────────────────────────────────────

  it('NEVER auto-approves — draft status is always "pending" in BFF POST body', async () => {
    const fleet = makeFleet(JSON.stringify({ text: 'Refined text', reasoning: 'Improved' }));
    const mockFetch = makeFetch('draft-pending-check');

    const pipeline = new ComposePipeline({
      fleet: fleet as unknown as FleetManager,
      supervisor: makeSupervisor(),
      fetchImpl: mockFetch,
    });

    await pipeline.composeDraft(BASE_INPUT);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Hardwall: status MUST be 'pending'. Never 'approved' or 'sent'.
    expect(body['status']).toBe('pending');
    expect(body['status']).not.toBe('approved');
    expect(body['status']).not.toBe('sent');
  });

  // ── BFF unreachable (fetch throws) ────────────────────────────────────────

  it('BFF unreachable (fetch throws) → returns BFF_UNREACHABLE error envelope', async () => {
    const fleet = makeFleet(JSON.stringify({ text: 'Refined', reasoning: 'Good' }));
    const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const pipeline = new ComposePipeline({
      fleet: fleet as unknown as FleetManager,
      supervisor: makeSupervisor(),
      fetchImpl: mockFetch,
    });

    const result = await pipeline.composeDraft(BASE_INPUT);
    expect('error' in result).toBe(true);
    const err = result as ComposeErrorResult;
    expect(err.error).toBe('BFF_UNREACHABLE');
  });

  // ── CC not installed (graceful degrade) ────────────────────────────────────

  it('CC_NOT_INSTALLED output → falls back to verbatim rawText; still posts draft', async () => {
    const fleet = makeFleet(
      'CC_NOT_INSTALLED — install via `brew install claude-code`',
    );
    const mockFetch = makeFetch('draft-no-cc');

    const pipeline = new ComposePipeline({
      fleet: fleet as unknown as FleetManager,
      supervisor: makeSupervisor(),
      fetchImpl: mockFetch,
    });

    const result = await pipeline.composeDraft(BASE_INPUT);

    expect('error' in result).toBe(false);
    const ok = result as ComposeResult;
    expect(ok.refinedText).toBe(BASE_INPUT.rawText);
    expect(ok.reasoning).toBe('CC parse failed; preserved input verbatim');
    expect(ok.draftId).toBe('draft-no-cc');
  });
});
