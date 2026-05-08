// =============================================================================
// TgChild unit tests (Cycle 14)
// =============================================================================

import { TgChild, TgAntiBanRefusedError, TgNotOpenError } from '../tg-child';
import type {
  TelegramClientLike,
  SecretsBackend,
  TelegramClientFactory,
  TgChildOptions,
} from '../tg-child';
import type { ChildContext } from '../../../base-child';
import { setBffCounterClient } from '../../../anti-ban';
import type { BffCounterClient } from '../../../anti-ban';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(id = 'tg-test'): ChildContext {
  return { id, platform: 'telegram' };
}

function makeMemorySecrets(initial?: Record<string, string>): SecretsBackend {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    async get(key) { return store.get(key) ?? null; },
    async set(key, value) { store.set(key, value); },
  };
}

function makeMockClient(overrides: Partial<{
  connectImpl: () => Promise<void>;
  isAuthorized: boolean;
  startImpl: (params: {
    phoneNumber: string | (() => Promise<string>);
    phoneCode: () => Promise<string>;
    onError: (e: Error) => void;
  }) => Promise<void>;
  sessionStr: string;
}> = {}): TelegramClientLike {
  const {
    connectImpl = async () => {},
    isAuthorized = true,
    startImpl,
    sessionStr = 'mock-session-string',
  } = overrides;

  return {
    connect: connectImpl,
    disconnect: async () => {},
    session: {
      save: () => sessionStr,
    },
    isUserAuthorized: async () => isAuthorized,
    start: startImpl ?? (async (_params) => {}),
    invoke: async (_req) => ({ dialogs: [], messages: [] }),
  };
}

function makeFactory(clientFactory?: () => TelegramClientLike): TelegramClientFactory {
  return (_sessionString, _apiId, _apiHash) =>
    clientFactory ? clientFactory() : makeMockClient();
}

function makeAllowClient(): BffCounterClient {
  return { increment: async () => ({ allowed: true, reasons: [] }) };
}

function makeRefuseClient(): BffCounterClient {
  return { increment: async () => ({ allowed: false, reasons: ['rate_limit'] }) };
}

function makeTgChild(opts: Partial<TgChildOptions> & { secrets?: SecretsBackend } = {}): TgChild {
  return new TgChild(makeCtx(), {
    account: 'personal',
    apiId: 12345,
    apiHash: 'testhash',
    telegramClientFactory: opts.telegramClientFactory ?? makeFactory(),
    secrets: opts.secrets ?? makeMemorySecrets(),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TgChild', () => {
  beforeEach(() => {
    // Wire a permissive anti-ban client by default
    setBffCounterClient(makeAllowClient());
  });

  afterEach(() => {
    setBffCounterClient(null);
  });

  // ---- Test 1: boots unpaired when no stored session -----------------------

  it('boots in unpaired state when no stored session', async () => {
    const child = makeTgChild({ secrets: makeMemorySecrets() });
    await child.start();
    expect(child.status).toBe('unpaired');
    expect(child.client).toBeNull();
  });

  // ---- Test 2: boots open when session exists ------------------------------

  it('boots in open state when session exists', async () => {
    const mockClient = makeMockClient({ isAuthorized: true });
    const factory = makeFactory(() => mockClient);
    const secrets = makeMemorySecrets({ 'tg-personal-session': 'saved-session' });
    const child = makeTgChild({ secrets, telegramClientFactory: factory });

    await child.start();
    expect(child.status).toBe('open');
    expect(child.client).toBe(mockClient);
  });

  // ---- Test 3: pair flow happy path — session persisted --------------------

  it('pair flow happy path stores session and transitions to open', async () => {
    const secrets = makeMemorySecrets();
    const mockClient = makeMockClient({
      startImpl: async (params) => {
        // Wait for the code to be provided via child.confirmCode()
        await new Promise<void>((res) => {
          void params.phoneCode().then(() => res());
        });
      },
    });
    const factory = makeFactory(() => mockClient);
    const child = makeTgChild({ secrets, telegramClientFactory: factory });
    await child.start();

    // Start pair (will hang waiting for code)
    const pairPromise = child.pair('+601234567890');

    // Slight delay to let the pair flow reach the phoneCode callback
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate Roki entering the code
    child.confirmCode('12345');

    const result = await pairPromise;
    expect(result.success).toBe(true);
    expect(child.status).toBe('open');

    // Session persisted to M12 secrets
    const stored = await secrets.get('tg-personal-session');
    expect(stored).toBe('mock-session-string');
  });

  // ---- Test 4: pair flow failure — stays unpaired, no session stored -------

  it('pair flow failure keeps status unpaired and stores no session', async () => {
    const secrets = makeMemorySecrets();
    const mockClient = makeMockClient({
      startImpl: async () => {
        throw new Error('PHONE_CODE_INVALID');
      },
    });
    const factory = makeFactory(() => mockClient);
    const child = makeTgChild({ secrets, telegramClientFactory: factory });
    await child.start();

    const result = await child.pair('+601234567890');
    expect(result.success).toBe(false);
    expect(result.error).toContain('PHONE_CODE_INVALID');
    expect(child.status).toBe('unpaired');

    const stored = await secrets.get('tg-personal-session');
    expect(stored).toBeNull();
  });

  // ---- Test 5: degrade mode when telegram package import fails -------------

  it('activates degrade mode when telegram package is absent', async () => {
    // Pass null factory explicitly to simulate missing package
    const child = new TgChild(makeCtx(), {
      account: 'personal',
      apiId: 12345,
      apiHash: 'testhash',
      telegramClientFactory: null as unknown as TelegramClientFactory,
      secrets: makeMemorySecrets(),
    });
    await child.start();

    expect(child.degradeMode).toBe(true);
    expect(child.status).toBe('unpaired');

    // pair() returns failure without throwing
    const result = await child.pair('+601234567890');
    expect(result.success).toBe(false);

    // listChats returns empty array, no throw
    const chats = await child.listChats();
    expect(chats).toEqual([]);

    // listMessages returns empty array, no throw
    const msgs = await child.listMessages('123');
    expect(msgs).toEqual([]);
  });

  // ---- Test 6: send() refuses if status !== 'open' -------------------------

  it('send() throws TgNotOpenError when status is unpaired', async () => {
    const child = makeTgChild({ secrets: makeMemorySecrets() });
    await child.start();
    expect(child.status).toBe('unpaired');

    await expect(child.send('+601111111111', 'hello')).rejects.toBeInstanceOf(TgNotOpenError);
  });

  // ---- Test 7: send() anti-ban gate refusal --------------------------------

  it('send() throws TgAntiBanRefusedError when anti-ban gate refuses', async () => {
    setBffCounterClient(makeRefuseClient());

    const mockClient = makeMockClient({ isAuthorized: true });
    const factory = makeFactory(() => mockClient);
    const secrets = makeMemorySecrets({ 'tg-personal-session': 'saved-session' });
    const child = makeTgChild({ secrets, telegramClientFactory: factory });
    await child.start();
    expect(child.status).toBe('open');

    await expect(child.send('+601111111111', 'hello')).rejects.toBeInstanceOf(
      TgAntiBanRefusedError,
    );
  });

  // ---- Test 8: 5+ parallel sends — all serialised, no crash ----------------

  it('handles 5 parallel send() calls safely', async () => {
    setBffCounterClient(makeAllowClient());

    const invokeCalls: string[] = [];
    const mockClient = makeMockClient({
      isAuthorized: true,
      startImpl: undefined,
    });
    // Override invoke to track calls (avoid JSON.stringify on BigInt)
    mockClient.invoke = async (req: unknown) => {
      invokeCalls.push(String((req as { _?: string })?._ ?? 'invoke'));
      return {};
    };

    const factory = makeFactory(() => mockClient);
    const secrets = makeMemorySecrets({ 'tg-personal-session': 'saved-session' });
    const child = makeTgChild({ secrets, telegramClientFactory: factory });
    await child.start();
    expect(child.status).toBe('open');

    // Fire 5 concurrent sends
    const results = await Promise.allSettled([
      child.send('+601111111111', 'msg 1'),
      child.send('+601111111112', 'msg 2'),
      child.send('+601111111113', 'msg 3'),
      child.send('+601111111114', 'msg 4'),
      child.send('+601111111115', 'msg 5'),
    ]);

    // All should succeed
    const failures = results.filter((r) => r.status === 'rejected');
    expect(failures).toHaveLength(0);
    expect(invokeCalls).toHaveLength(5);
  });

  // ---- Test 9: health() reflects status ------------------------------------

  it('health() returns ok=true when open and ok=false when unpaired', async () => {
    const child = makeTgChild({ secrets: makeMemorySecrets() });
    await child.start();

    const h = await child.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('unpaired');

    // Simulate transition to open
    const mockClient = makeMockClient({ isAuthorized: true });
    const factory = makeFactory(() => mockClient);
    const secrets2 = makeMemorySecrets({ 'tg-personal-session': 'sess' });
    const child2 = makeTgChild({ secrets: secrets2, telegramClientFactory: factory });
    await child2.start();

    const h2 = await child2.health();
    expect(h2.ok).toBe(true);
  });

  // ---- Test 10: stop() disconnects client and sets disconnected status ------

  it('stop() disconnects client and transitions to disconnected', async () => {
    let disconnected = false;
    const mockClient = makeMockClient({
      isAuthorized: true,
    });
    mockClient.disconnect = async () => { disconnected = true; };

    const factory = makeFactory(() => mockClient);
    const secrets = makeMemorySecrets({ 'tg-personal-session': 'saved-session' });
    const child = makeTgChild({ secrets, telegramClientFactory: factory });
    await child.start();
    expect(child.status).toBe('open');

    await child.stop(true);
    expect(disconnected).toBe(true);
    expect(child.status).toBe('disconnected');
    expect(child.client).toBeNull();
  });
});
