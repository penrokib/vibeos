// =============================================================================
// anti-ban.test.ts
// -----------------------------------------------------------------------------
// Covers:
//   - Synthetic 429 from BFF → withAntiBan refuses (allowed=false, reasons set)
//   - Allowed verdict invokes the wrapped fn
//   - Failing closed: no client installed = refusal
//   - CC-modal hardwall (feedback-cc-modal-dismiss.md): bare 2/3 + Enter
//     keystroke is REFUSED.
// =============================================================================

import {
  assertSafeTmuxKeystroke,
  HttpBffCounterClient,
  isSafeTmuxKeystroke,
  setBffCounterClient,
  UnsafeKeystrokeError,
  withAntiBan,
  type BffCounterClient,
} from '../anti-ban';

afterEach(() => {
  setBffCounterClient(null);
});

describe('withAntiBan', () => {
  it('refuses when no client is installed (failing-closed)', async () => {
    setBffCounterClient(null);
    const fn = jest.fn(async () => 'sent');
    const r = await withAntiBan({ childId: 'wa-1', action: 'send' }, fn);
    expect(r.allowed).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    if (!r.allowed) {
      expect(r.verdict.reasons).toContain('no_anti_ban_client_installed');
    }
  });

  it('refuses on synthetic 429 from BFF', async () => {
    const client: BffCounterClient = {
      increment: async () => ({
        allowed: false,
        reasons: ['rate_hour_exceeded', 'similarity>0.85'],
        nextWindowAt: '2026-05-07T09:14:00Z',
        counters: { hour: 62, day: 287 },
      }),
    };
    setBffCounterClient(client);
    const fn = jest.fn(async () => 'sent');
    const r = await withAntiBan({ childId: 'wa-1', action: 'send' }, fn);
    expect(r.allowed).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    if (!r.allowed) {
      expect(r.verdict.reasons).toEqual(['rate_hour_exceeded', 'similarity>0.85']);
      expect(r.verdict.nextWindowAt).toBe('2026-05-07T09:14:00Z');
    }
  });

  it('allows + invokes fn when BFF returns allowed=true', async () => {
    const client: BffCounterClient = {
      increment: async () => ({ allowed: true, counters: { hour: 1 } }),
    };
    setBffCounterClient(client);
    const fn = jest.fn(async () => 42);
    const r = await withAntiBan({ childId: 'wa-1', action: 'send' }, fn);
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      expect(r.value).toBe(42);
    }
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes meta through to the BFF client', async () => {
    const inc = jest.fn().mockResolvedValue({ allowed: true });
    setBffCounterClient({ increment: inc });
    await withAntiBan(
      { childId: 'tg-1', action: 'send', accountId: 'acc-x', meta: { len: 12 } },
      async () => undefined,
    );
    expect(inc).toHaveBeenCalledWith({
      childId: 'tg-1',
      action: 'send',
      accountId: 'acc-x',
      meta: { len: 12 },
    });
  });
});

describe('HttpBffCounterClient', () => {
  it('treats 429 as a refusal with parsed reasons', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          allowed: false,
          reasons: ['rate_minute_exceeded'],
          counters: { minute: 9 },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    const c = new HttpBffCounterClient({
      baseUrl: 'http://x',
      token: 't',
      fetchImpl: fakeFetch,
    });
    const v = await c.increment({ childId: 'wa-1', action: 'send' });
    expect(v.allowed).toBe(false);
    expect(v.reasons).toContain('rate_minute_exceeded');
  });

  it('treats 5xx as a refusal', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('boom', { status: 503 });
    const c = new HttpBffCounterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fakeFetch });
    const v = await c.increment({ childId: 'wa-1', action: 'send' });
    expect(v.allowed).toBe(false);
    expect(v.reasons?.[0]).toMatch(/bff_503/);
  });

  it('treats network error as a refusal', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const c = new HttpBffCounterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fakeFetch });
    const v = await c.increment({ childId: 'wa-1', action: 'send' });
    expect(v.allowed).toBe(false);
    expect(v.reasons?.[0]).toMatch(/bff_unreachable/);
  });

  it('returns allowed when BFF says ok', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ allowed: true, counters: { hour: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const c = new HttpBffCounterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fakeFetch });
    const v = await c.increment({ childId: 'wa-1', action: 'send' });
    expect(v.allowed).toBe(true);
    expect(v.counters?.['hour']).toBe(1);
  });
});

// =============================================================================
// CC-modal hardwall regression — feedback-cc-modal-dismiss.md
// =============================================================================
describe('CC-modal keystroke hardwall', () => {
  it('refuses bare "2" + Enter (extra usage — billing change)', () => {
    expect(() => assertSafeTmuxKeystroke(['2', 'Enter'])).toThrow(UnsafeKeystrokeError);
    expect(() => assertSafeTmuxKeystroke('2\r')).toThrow(UnsafeKeystrokeError);
    expect(() => assertSafeTmuxKeystroke('2\n')).toThrow(UnsafeKeystrokeError);
    expect(() => assertSafeTmuxKeystroke('2\r\n')).toThrow(UnsafeKeystrokeError);
  });

  it('refuses bare "3" + Enter (Team plan — billing change)', () => {
    expect(() => assertSafeTmuxKeystroke(['3', 'Enter'])).toThrow(UnsafeKeystrokeError);
    expect(() => assertSafeTmuxKeystroke('3\r')).toThrow(UnsafeKeystrokeError);
  });

  it('allows bare "1" + Enter (Stop and wait is the intended dismiss)', () => {
    expect(() => assertSafeTmuxKeystroke(['1', 'Enter'])).not.toThrow();
    expect(isSafeTmuxKeystroke('1\r')).toBe(true);
  });

  it('allows bare "0" alone (feedback dismiss)', () => {
    expect(() => assertSafeTmuxKeystroke(['0'])).not.toThrow();
    expect(() => assertSafeTmuxKeystroke('0')).not.toThrow();
  });

  it('allows multi-digit numbers like 23 or 32', () => {
    expect(() => assertSafeTmuxKeystroke('23\r')).not.toThrow();
    expect(() => assertSafeTmuxKeystroke('32\r')).not.toThrow();
  });

  it('allows 2 or 3 not followed by Enter', () => {
    expect(() => assertSafeTmuxKeystroke(['2'])).not.toThrow();
    expect(() => assertSafeTmuxKeystroke(['3', 'a'])).not.toThrow();
  });

  it('isSafeTmuxKeystroke returns boolean', () => {
    expect(isSafeTmuxKeystroke('2\r')).toBe(false);
    expect(isSafeTmuxKeystroke('hello')).toBe(true);
  });
});
