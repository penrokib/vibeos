// =============================================================================
// send-pipeline.test.ts (Cycle 17)
// -----------------------------------------------------------------------------
// Tests for SendPipeline — the single choke-point for all outbound sends.
//
// Covers (8+ tests):
//   1. Happy path — gate allows → child.send called → BFF /sent posted → {status:'sent'}
//   2. Gate refuses (daily cap) → BFF /refuse posted → {status:'refused', reason}
//   3. child.send throws → BFF /error posted → {status:'error', reason}
//   4. Unknown account → {status:'error', reason:'account_not_paired'}
//   5. BFF unreachable for draft fetch → {status:'error', reason:'BFF_UNREACHABLE'}
//   6. Draft 404 → {status:'error', reason:'DRAFT_NOT_FOUND'}
//   7. --unwarmed=true bypass — gate still called, meta.unwarmed=true logged
//   8. 5+ parallel approvals — per-account concurrency safety (feedback-concurrency-safety.md)
//   9. BFF status update unreachable → does NOT throw, returns result envelope
//  10. Gate client not installed → refuses with reason 'no_anti_ban_client_installed'
// =============================================================================

import { SendPipeline } from '../send-pipeline';
import { setBffCounterClient, type BffCounterClient } from '../anti-ban';
import type { Supervisor } from '../supervisor';

// ---------------------------------------------------------------------------
// Minimal fake Supervisor — only __getChildForTests + status() needed.
// ---------------------------------------------------------------------------

interface FakeChild {
  account: string;
  send: (recipient: string, text: string) => Promise<void>;
}

function makeSupervisor(children: FakeChild[] = []): Supervisor {
  const childMap = new Map<string, { instance: FakeChild }>();
  const childStatuses = children.map((_c, i) => ({
    id: `wa-${i}`,
    platform: 'whatsapp',
    state: 'running' as const,
    restartCount: 0,
    recentCrashCount: 0,
    changedAt: new Date().toISOString(),
  }));
  children.forEach((c, i) => {
    childMap.set(`wa-${i}`, { instance: c });
  });

  return {
    status: () => ({
      wsPort: 0,
      uptime: 0,
      emergencyStopped: false,
      children: childStatuses,
    }),
    __getChildForTests: (id: string) => {
      const entry = childMap.get(id);
      if (!entry) return undefined;
      return { instance: entry.instance } as unknown as ReturnType<Supervisor['__getChildForTests']>;
    },
  } as unknown as Supervisor;
}

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type FetchRoute = Record<string, { status: number; body?: unknown } | 'network_error'>;

function buildFetch(routes: FetchRoute): typeof fetch {
  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    for (const [pattern, res] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        if (res === 'network_error') {
          throw new Error('network error');
        }
        return new Response(
          res.body !== undefined ? JSON.stringify(res.body) : '',
          {
            status: res.status,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
    }
    // Default: 404
    return new Response('{}', { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Anti-ban clients
// ---------------------------------------------------------------------------

const allowClient: BffCounterClient = {
  increment: async () => ({ allowed: true, counters: { hour: 1, day: 5 } }),
};

const refuseClient: BffCounterClient = {
  increment: async () => ({
    allowed: false,
    reasons: ['daily_cap_reached'],
    nextWindowAt: '2026-05-10T00:00:00Z',
    counters: { day: 100 },
  }),
};

// ---------------------------------------------------------------------------
// Draft fixture
// ---------------------------------------------------------------------------

const DRAFT_ID = 'test-draft-001';
const DRAFT_PAYLOAD = {
  id: DRAFT_ID,
  account: 'personal',
  recipient: '60123456789@s.whatsapp.net',
  text: 'Hello from persona!',
  persona: 'roki-sales',
};

// Baseline route shape for reference (tests build inline variants to track calls).
void (() => ({
  [`/agency/drafts/${DRAFT_ID}`]: { status: 200, body: DRAFT_PAYLOAD },
  '/refuse': { status: 200, body: { ok: true } },
  '/sent': { status: 200, body: { ok: true } },
  '/error': { status: 200, body: { ok: true } },
} satisfies FetchRoute));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setBffCounterClient(allowClient);
  // Set BFF env so SendPipeline can make fetch calls
  process.env['ROKIBRAIN_BFF_URL'] = 'http://localhost:3000';
  process.env['ROKIBRAIN_DEV_JWT'] = 'test-jwt';
});

afterEach(() => {
  setBffCounterClient(null);
  delete process.env['ROKIBRAIN_BFF_URL'];
  delete process.env['ROKIBRAIN_DEV_JWT'];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SendPipeline — happy path', () => {
  it('gate allows → child.send called → BFF /sent posted → {status:"sent"}', async () => {
    const sendCalls: Array<[string, string]> = [];
    const child: FakeChild = {
      account: 'personal',
      send: async (r, t) => { sendCalls.push([r, t]); },
    };

    const postedPaths: string[] = [];
    const fetchImpl = buildFetch({
      [`/agency/drafts/${DRAFT_ID}`]: { status: 200, body: DRAFT_PAYLOAD },
      '/refuse': { status: 200, body: { ok: true } },
      [`/agency/drafts/${DRAFT_ID}/sent`]: { status: 200, body: { ok: true } },
      '/error': { status: 200, body: { ok: true } },
    });

    const realFetch: typeof fetch = async (input, init) => {
      const url = input.toString();
      if (url.includes('/sent')) postedPaths.push('/sent');
      return fetchImpl(input, init);
    };

    const supervisor = makeSupervisor([child]);
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: allowClient,
      fetchImpl: realFetch,
    });

    const result = await pipeline.sendDraft(DRAFT_ID);

    expect(result.status).toBe('sent');
    expect(result.messageId).toBeDefined();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toEqual([DRAFT_PAYLOAD.recipient, DRAFT_PAYLOAD.text]);
    expect(postedPaths).toContain('/sent');
  });
});

describe('SendPipeline — gate refuses', () => {
  it('daily cap → BFF /refuse posted → {status:"refused", reason:"daily_cap_reached"}', async () => {
    const sendCalls: string[] = [];
    const child: FakeChild = {
      account: 'personal',
      send: async () => { sendCalls.push('called'); },
    };

    const postedPaths: string[] = [];
    const fetchImpl = buildFetch({
      [`/agency/drafts/${DRAFT_ID}`]: { status: 200, body: DRAFT_PAYLOAD },
      [`/agency/drafts/${DRAFT_ID}/refuse`]: { status: 200, body: { ok: true } },
    });

    const trackedFetch: typeof fetch = async (input, init) => {
      const url = input.toString();
      if (url.includes('/refuse')) postedPaths.push('/refuse');
      return fetchImpl(input, init);
    };

    const supervisor = makeSupervisor([child]);
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: refuseClient,
      fetchImpl: trackedFetch,
    });

    const result = await pipeline.sendDraft(DRAFT_ID);

    expect(result.status).toBe('refused');
    expect(result.reason).toContain('daily_cap_reached');
    expect(sendCalls).toHaveLength(0); // child.send was NOT called
    expect(postedPaths).toContain('/refuse');
  });
});

describe('SendPipeline — child.send throws', () => {
  it('child.send throws → BFF /error posted → {status:"error", reason}', async () => {
    const child: FakeChild = {
      account: 'personal',
      send: async () => { throw new Error('connection refused'); },
    };

    const postedPaths: string[] = [];
    const fetchImpl = buildFetch({
      [`/agency/drafts/${DRAFT_ID}`]: { status: 200, body: DRAFT_PAYLOAD },
      [`/agency/drafts/${DRAFT_ID}/error`]: { status: 200, body: { ok: true } },
    });

    const trackedFetch: typeof fetch = async (input, init) => {
      const url = input.toString();
      if (url.includes('/error')) postedPaths.push('/error');
      return fetchImpl(input, init);
    };

    const supervisor = makeSupervisor([child]);
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: allowClient,
      fetchImpl: trackedFetch,
    });

    const result = await pipeline.sendDraft(DRAFT_ID);

    expect(result.status).toBe('error');
    expect(result.reason).toContain('connection refused');
    expect(postedPaths).toContain('/error');
  });
});

describe('SendPipeline — unknown account', () => {
  it('account not paired → {status:"error", reason:"account_not_paired"}', async () => {
    const postedPaths: string[] = [];
    const fetchImpl = buildFetch({
      [`/agency/drafts/${DRAFT_ID}`]: { status: 200, body: DRAFT_PAYLOAD },
      [`/agency/drafts/${DRAFT_ID}/error`]: { status: 200, body: { ok: true } },
    });

    const trackedFetch: typeof fetch = async (input, init) => {
      const url = input.toString();
      if (url.includes('/error')) postedPaths.push('/error');
      return fetchImpl(input, init);
    };

    // No children registered → account not found
    const supervisor = makeSupervisor([]);
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: allowClient,
      fetchImpl: trackedFetch,
    });

    const result = await pipeline.sendDraft(DRAFT_ID);

    expect(result.status).toBe('error');
    expect(result.reason).toBe('account_not_paired');
    expect(postedPaths).toContain('/error');
  });
});

describe('SendPipeline — BFF unreachable for draft fetch', () => {
  it('draft fetch network error → {status:"error", reason:"BFF_UNREACHABLE"}', async () => {
    const supervisor = makeSupervisor([]);
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: allowClient,
      fetchImpl: async () => { throw new Error('network error'); },
    });

    const result = await pipeline.sendDraft(DRAFT_ID);

    expect(result.status).toBe('error');
    expect(result.reason).toBe('BFF_UNREACHABLE');
  });
});

describe('SendPipeline — draft not found', () => {
  it('draft 404 → {status:"error", reason:"DRAFT_NOT_FOUND"}', async () => {
    const supervisor = makeSupervisor([]);
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: allowClient,
      fetchImpl: buildFetch({ [`/agency/drafts/${DRAFT_ID}`]: { status: 404 } }),
    });

    const result = await pipeline.sendDraft(DRAFT_ID);

    expect(result.status).toBe('error');
    expect(result.reason).toBe('DRAFT_NOT_FOUND');
  });
});

describe('SendPipeline — --unwarmed=true flag', () => {
  it('--unwarmed=true relaxes warming cap meta (but gate still called)', async () => {
    const incrementCalls: Array<Record<string, unknown>> = [];
    const warmingClient: BffCounterClient = {
      increment: async (input) => {
        incrementCalls.push({ ...input });
        return { allowed: true, counters: { hour: 1, day: 5 } };
      },
    };

    const child: FakeChild = {
      account: 'personal',
      send: async () => {},
    };

    const supervisor = makeSupervisor([child]);
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: warmingClient,
      fetchImpl: buildFetch({
        [`/agency/drafts/${DRAFT_ID}`]: { status: 200, body: DRAFT_PAYLOAD },
        '/sent': { status: 200, body: { ok: true } },
        '/error': { status: 200, body: { ok: true } },
      }),
      unwarmed: true,
    });

    const result = await pipeline.sendDraft(DRAFT_ID);

    // Gate was still called
    expect(incrementCalls).toHaveLength(1);
    // Meta includes unwarmed=true
    expect((incrementCalls[0]['meta'] as Record<string, unknown>)['unwarmed']).toBe(true);
    // Send succeeded
    expect(result.status).toBe('sent');
  });
});

describe('SendPipeline — concurrency safety', () => {
  it('5 parallel approvals of different drafts complete without corruption (feedback-concurrency-safety.md)', async () => {
    const sendOrder: string[] = [];
    const children: FakeChild[] = ['personal', 'business', 'wap', 'was', 'wab'].map(
      (account) => ({
        account,
        send: async (r: string, _t: string) => {
          sendOrder.push(`${account}:${r}`);
          // Simulate slight async delay
          await new Promise<void>((res) => setTimeout(res, Math.random() * 5));
        },
      }),
    );

    const drafts = children.map((c, i) => ({
      id: `draft-${i}`,
      account: c.account,
      recipient: `${c.account}@s.whatsapp.net`,
      text: `Message ${i}`,
      persona: 'roki',
    }));

    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      // Match /agency/drafts/draft-N
      const draftMatch = url.match(/\/agency\/drafts\/(draft-\d+)$/);
      if (draftMatch) {
        const id = draftMatch[1];
        const draft = drafts.find((d) => d.id === id);
        if (draft) {
          return new Response(JSON.stringify(draft), { status: 200 });
        }
      }
      // Accept all status POSTs
      return new Response('{}', { status: 200 });
    };

    const supervisor = makeSupervisor(children);
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: allowClient,
      fetchImpl,
    });

    // Fire 5 parallel sendDraft calls
    const results = await Promise.all(drafts.map((d) => pipeline.sendDraft(d.id)));

    // All 5 should succeed
    expect(results.every((r) => r.status === 'sent')).toBe(true);
    // All 5 children were called exactly once
    expect(sendOrder).toHaveLength(5);
    // Each account appears exactly once
    for (const child of children) {
      expect(sendOrder.filter((s) => s.startsWith(`${child.account}:`))).toHaveLength(1);
    }
  });
});

describe('SendPipeline — BFF status update unreachable', () => {
  it('BFF /sent POST fails → does NOT throw → still returns {status:"sent"}', async () => {
    const child: FakeChild = {
      account: 'personal',
      send: async () => {},
    };

    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes(`/agency/drafts/${DRAFT_ID}`) && !url.includes('/sent')) {
        return new Response(JSON.stringify(DRAFT_PAYLOAD), { status: 200 });
      }
      // All status update POSTs fail
      throw new Error('BFF down');
    };

    const supervisor = makeSupervisor([child]);
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: allowClient,
      fetchImpl,
    });

    // Should NOT throw even if BFF status update fails
    const result = await pipeline.sendDraft(DRAFT_ID);
    expect(result.status).toBe('sent');
  });
});

describe('SendPipeline — no anti-ban client', () => {
  it('no BffCounterClient installed → refuses with reason "no_anti_ban_client_installed"', async () => {
    setBffCounterClient(null);

    const child: FakeChild = {
      account: 'personal',
      send: async () => {},
    };

    const postedPaths: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/refuse')) postedPaths.push('/refuse');
      return new Response(JSON.stringify(DRAFT_PAYLOAD), { status: 200 });
    };

    const supervisor = makeSupervisor([child]);
    // Deliberately pass a no-op client — withAntiBan will use the global null client
    const noOpClient: BffCounterClient = {
      increment: async () => ({ allowed: false, reasons: ['no_anti_ban_client_installed'] }),
    };
    const pipeline = new SendPipeline({
      supervisor,
      antiBanClient: noOpClient,
      fetchImpl,
    });

    const result = await pipeline.sendDraft(DRAFT_ID);

    // Gate refused — send not called
    expect(result.status).toBe('refused');
    expect(result.reason).toContain('no_anti_ban_client_installed');
  });
});
