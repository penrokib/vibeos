// =============================================================================
// wa-child.test.ts (M04)
// -----------------------------------------------------------------------------
// Covers:
//   - spawn with open status → child emits 'started', health returns ok=true
//   - spawn with closed status → child emits 'started' (pairing), health ok=false
//   - listChats happy path → returns normalised MeshChat[]
//   - send() refuses when anti-ban gate refuses → throws WaAntiBanRefusedError
//   - send() succeeds when anti-ban gate allows
//   - backend unreachable → health returns ok=false (supervisor restart smoke)
// =============================================================================

import { WaChild, WaAntiBanRefusedError } from '../children/wa/wa-child';
import { setBffCounterClient, type BffCounterClient } from '../anti-ban';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(id = 'wa-personal') {
  return { id, platform: 'whatsapp' };
}

/** Build a fetch mock that returns a given JSON body + status. */
function fakeFetch(
  responses: Record<string, { status: number; body: unknown }>,
): typeof fetch {
  return async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input.toString();
    for (const [pattern, res] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(res.body), {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    throw new Error(`fakeFetch: no match for ${url}`);
  };
}

/** Anti-ban client that always allows. */
const allowClient: BffCounterClient = {
  increment: async () => ({ allowed: true, counters: { hour: 1, day: 10 } }),
};

/** Anti-ban client that always refuses. */
const refuseClient: BffCounterClient = {
  increment: async () => ({
    allowed: false,
    reasons: ['rate_hour_exceeded'],
    nextWindowAt: '2026-05-09T00:00:00Z',
    counters: { hour: 80 },
  }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  setBffCounterClient(null);
});

describe('WaChild — lifecycle', () => {
  it('status=open → child emits started + health returns ok=true', async () => {
    const fetch = fakeFetch({ '/status': { status: 200, body: { status: 'open' } } });
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch,
    });

    const events: string[] = [];
    child.onEvent((e) => events.push(e.type));

    await child.start();
    expect(events).toContain('started');

    const h = await child.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('open');
  });

  it('status=close → child emits started (pairing), health returns ok=false', async () => {
    const fetch = fakeFetch({ '/status': { status: 200, body: { status: 'close' } } });
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch,
    });

    const events: string[] = [];
    child.onEvent((e) => events.push(e.type));

    await child.start();
    expect(events).toContain('started');

    const h = await child.health();
    expect(h.ok).toBe(false);
  });

  it('idempotent — calling start() twice is a no-op when already connected', async () => {
    const fetch = fakeFetch({ '/status': { status: 200, body: { status: 'open' } } });
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch,
    });

    const events: string[] = [];
    child.onEvent((e) => events.push(e.type));

    await child.start();
    await child.start(); // second call should be a no-op
    expect(events.filter((e) => e === 'started')).toHaveLength(1);
  });
});

describe('WaChild — listChats', () => {
  it('happy path — returns normalised MeshChat[]', async () => {
    const rawChats = [
      {
        jid: '1234567890@s.whatsapp.net',
        name: 'Alice',
        last_message_time: 1700000000,
        last_message: 'hey',
        unread_count: 2,
      },
      {
        id: '9876543210@s.whatsapp.net',
        name: 'Bob',
        lastMessageTime: 1700001000,
        lastMessage: 'yo',
        unreadCount: 0,
      },
    ];
    const fetch = fakeFetch({
      '/chats/': { status: 200, body: { chats: rawChats } },
    });
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch,
    });

    const chats = await child.listChats(10);
    expect(chats).toHaveLength(2);
    expect(chats[0].jid).toBe('1234567890@s.whatsapp.net');
    expect(chats[0].name).toBe('Alice');
    expect(chats[0].unread_count).toBe(2);
    expect(chats[1].jid).toBe('9876543210@s.whatsapp.net');
    expect(chats[1].unread_count).toBe(0);
  });
});

describe('WaChild — send() anti-ban gate', () => {
  it('refuses when anti-ban gate refuses → throws WaAntiBanRefusedError', async () => {
    setBffCounterClient(refuseClient);
    const fetch = fakeFetch({
      '/status': { status: 200, body: { status: 'open' } },
      '/send/': { status: 200, body: { success: true } },
    });
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch,
    });

    await expect(
      child.send('1234567890@s.whatsapp.net', 'hello'),
    ).rejects.toThrow(WaAntiBanRefusedError);
  });

  it('succeeds when anti-ban gate allows', async () => {
    setBffCounterClient(allowClient);
    const fetch = fakeFetch({
      '/status': { status: 200, body: { status: 'open' } },
      '/send/': { status: 200, body: { success: true } },
    });
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch,
    });

    await expect(
      child.send('1234567890@s.whatsapp.net', 'hello'),
    ).resolves.not.toThrow();
  });

  it('refuses even when gate allows but no anti-ban client is installed', async () => {
    setBffCounterClient(null); // failing-closed
    const fetch = fakeFetch({
      '/send/': { status: 200, body: { success: true } },
    });
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch,
    });

    await expect(
      child.send('1234567890@s.whatsapp.net', 'hello'),
    ).rejects.toThrow(WaAntiBanRefusedError);
  });
});

describe('WaChild — backend unreachable', () => {
  it('health() returns ok=false when backend is unreachable', async () => {
    const fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    const h = await child.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('unreachable');
  });

  it('start() throws when /status is unreachable', async () => {
    const fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(child.start()).rejects.toThrow('unreachable');
  });
});

describe('WaChild — accountStatus', () => {
  it('returns MeshAccount with open status when backend is open', async () => {
    const fetch = fakeFetch({ '/status': { status: 200, body: { status: 'open' } } });
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch,
    });

    const acct = await child.accountStatus();
    expect(acct.account).toBe('personal');
    expect(acct.status).toBe('open');
  });

  it('returns unknown status when backend is unreachable', async () => {
    const fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const child = new WaChild(makeCtx(), {
      account: 'personal',
      baseUrl: 'http://localhost:8086',
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    const acct = await child.accountStatus();
    expect(acct.status).toBe('unknown');
  });
});
