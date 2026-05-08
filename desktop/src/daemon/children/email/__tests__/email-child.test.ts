// =============================================================================
// rokibrain.app — EmailChild tests (Cycle 15)
// -----------------------------------------------------------------------------
// Mocks imapflow + nodemailer; verifies boot state, pairing, send, degrade
// mode, IMAP IDLE events, and tenant isolation.
// =============================================================================

import { EventEmitter } from 'node:events';
import { EmailChild } from '../email-child';
import type { EmailCreds, ImapFlowLike } from '../email-child';
import type { ChildContext } from '../../../base-child';

// ---------------------------------------------------------------------------
// Mock imapflow + nodemailer via jest.mock
// ---------------------------------------------------------------------------

/** Shared IMAP mock factory — recreated per test via resetMocks(). */
let mockImapConnected = false;
let mockImapConnectShouldThrow: Error | null = null;
const mockImapEventEmitter = new EventEmitter();
let mockImapLogoutCalled = false;

const createMockImap = (): ImapFlowLike => {
  const imap: ImapFlowLike = {
    connect: jest.fn(async () => {
      if (mockImapConnectShouldThrow) throw mockImapConnectShouldThrow;
      mockImapConnected = true;
    }),
    logout: jest.fn(async () => {
      mockImapConnected = false;
      mockImapLogoutCalled = true;
    }),
    idle: jest.fn(async () => undefined),
    on: jest.fn((evt, cb) => { mockImapEventEmitter.on(evt, cb); return imap; }),
    off: jest.fn((evt, cb) => { mockImapEventEmitter.off(evt, cb); return imap; }),
    authenticated: true,
    mailboxOpen: jest.fn(async () => ({})),
    fetch: jest.fn(async function* () { /* empty */ }),
  };
  return imap;
};

let mockImapInstance: ImapFlowLike = createMockImap();
let mockNodemailerSendShouldThrow: Error | null = null;
let mockSendMailCalled = false;

const mockNodemailerTransport = {
  sendMail: jest.fn(async (_opts: unknown) => {
    if (mockNodemailerSendShouldThrow) throw mockNodemailerSendShouldThrow;
    mockSendMailCalled = true;
    return { messageId: 'test-msg-id' };
  }),
  close: jest.fn(),
};

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn(() => mockImapInstance),
}), { virtual: true });

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => mockNodemailerTransport),
}), { virtual: true });

// ---------------------------------------------------------------------------
// Anti-ban mock (withAntiBan must be set up to allow sends in tests)
// ---------------------------------------------------------------------------

let antiBanAllowed = true;

jest.mock('../../../anti-ban', () => ({
  withAntiBan: jest.fn(async (
    _meta: unknown,
    action: () => Promise<void>,
  ) => {
    if (!antiBanAllowed) {
      return { allowed: false, verdict: { reasons: ['test-blocked'] } };
    }
    await action();
    return { allowed: true, verdict: {} };
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function resetMocks(): void {
  mockImapConnected = false;
  mockImapConnectShouldThrow = null;
  mockImapLogoutCalled = false;
  mockSendMailCalled = false;
  mockNodemailerTransport.close.mockClear();
  mockNodemailerSendShouldThrow = null;
  antiBanAllowed = true;
  mockImapEventEmitter.removeAllListeners();
  mockImapInstance = createMockImap();
  jest.clearAllMocks();
}

function makeCtx(id = 'email-test'): ChildContext {
  return { id, platform: 'email' };
}

/** Module loader that returns real mocks (normal path). */
function makeRealModuleLoader(): NonNullable<import('../email-child').EmailChildOptions['moduleLoader']> {
  return {
    loadImapFlow: async () => ({ ImapFlow: jest.fn(() => mockImapInstance) }),
    loadNodemailer: async () => ({ createTransport: jest.fn(() => mockNodemailerTransport) }),
  };
}

/** Module loader that simulates missing packages (degrade path). */
function makeDegradeModuleLoader(): NonNullable<import('../email-child').EmailChildOptions['moduleLoader']> {
  return {
    loadImapFlow: async () => null,
    loadNodemailer: async () => null,
  };
}

const VALID_CREDS: EmailCreds = {
  imapHost: 'imap.example.com',
  imapPort: 993,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  user: 'test@example.com',
  pass: 'secret',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailChild', () => {
  beforeEach(resetMocks);

  // ---- Test 1: boots unpaired when no creds --------------------------------
  it('boots in unpaired state when no creds in secrets', async () => {
    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      moduleLoader: makeRealModuleLoader(),
      secretsGet: async () => null,
      secretsSet: async () => undefined,
    });

    await child.start();

    expect(child.status).toBe('unpaired');
    expect(child.degradeMode).toBe(false);
  });

  // ---- Test 2: boots open with stored creds --------------------------------
  it('boots in open state when creds are present in M12 secrets', async () => {
    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      moduleLoader: makeRealModuleLoader(),
      secretsGet: async () => JSON.stringify(VALID_CREDS),
      secretsSet: async () => undefined,
    });

    await child.start();

    expect(child.status).toBe('open');
    expect(mockImapConnected).toBe(true);
  });

  // ---- Test 3: pair() with valid creds → status open ----------------------
  it('pair() with valid creds transitions to open and stores secret', async () => {
    let storedKey = '';
    let storedValue = '';

    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      tenantId: 'tenant-a',
      moduleLoader: makeRealModuleLoader(),
      secretsGet: async () => null,
      secretsSet: async (k, v) => { storedKey = k; storedValue = v; },
    });

    await child.start();
    expect(child.status).toBe('unpaired');

    const result = await child.pair(VALID_CREDS);

    expect(result.success).toBe(true);
    expect(child.status).toBe('open');
    expect(storedKey).toBe('email-tenant-a:test-account-creds');
    expect(JSON.parse(storedValue)).toMatchObject({ user: VALID_CREDS.user });
  });

  // ---- Test 4: pair() with invalid creds → stays unpaired, error surfaced --
  it('pair() with failing IMAP connection stays unpaired and returns error', async () => {
    mockImapConnectShouldThrow = new Error('ECONNREFUSED');

    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      moduleLoader: makeRealModuleLoader(),
      secretsGet: async () => null,
      secretsSet: async () => undefined,
    });

    await child.start();

    const result = await child.pair(VALID_CREDS);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(child.status).toBe('unpaired');
  });

  // ---- Test 5: send() refuses if status !== 'open' -------------------------
  it('send() throws EmailSendBlockedError when status is not open', async () => {
    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      moduleLoader: makeRealModuleLoader(),
      secretsGet: async () => null,
      secretsSet: async () => undefined,
    });

    await child.start(); // → unpaired
    expect(child.status).toBe('unpaired');

    await expect(child.send('target@example.com', 'hello')).rejects.toThrow(
      'email send blocked',
    );
    expect(mockSendMailCalled).toBe(false);
  });

  // ---- Test 6: degrade mode when modules not installed ---------------------
  it('enters degrade mode and stays unpaired when imapflow/nodemailer missing', async () => {
    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      moduleLoader: makeDegradeModuleLoader(),
      secretsGet: async () => null,
      secretsSet: async () => undefined,
    });

    await child.start();

    expect(child.degradeMode).toBe(true);
    expect(child.status).toBe('unpaired');

    // listChats returns a degrade stub (no throw)
    const chats = await child.listChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toContain('install imapflow');

    // send() refuses gracefully
    await expect(child.send('target@example.com', 'hi')).rejects.toThrow(
      'degrade-mode',
    );
  });

  // ---- Test 7: IMAP IDLE event emits MeshMessage on new mail ---------------
  it('emits new-mail MeshMessage when IMAP IDLE delivers an exists event', async () => {
    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      moduleLoader: makeRealModuleLoader(),
      secretsGet: async () => JSON.stringify(VALID_CREDS),
      secretsSet: async () => undefined,
    });

    await child.start();
    expect(child.status).toBe('open');

    const received: unknown[] = [];
    child.onNewMail((msg) => { received.push(msg); });

    // Simulate IMAP IDLE "exists" push
    mockImapEventEmitter.emit('exists', { count: 42 });

    expect(received).toHaveLength(1);
    const msg = received[0] as { chat_jid: string; is_from_me: number };
    expect(msg.chat_jid).toBe('INBOX');
    expect(msg.is_from_me).toBe(0);
  });

  // ---- Test 8: tenant isolation — secret keys are scoped per tenant --------
  it('tenant isolation: different tenants use different secret keys', async () => {
    const keysRead: string[] = [];

    const makeChild = (tenantId: string, account: string): EmailChild =>
      new EmailChild(makeCtx(`${tenantId}-${account}`), {
        account,
        tenantId,
        moduleLoader: makeRealModuleLoader(),
        secretsGet: async (k) => { keysRead.push(k); return null; },
        secretsSet: async () => undefined,
      });

    const childA = makeChild('tenant-a', 'inbox');
    const childB = makeChild('tenant-b', 'inbox');

    await childA.start();
    await childB.start();

    // Both unpaired — but the keys they probed must differ
    const keyA = keysRead.find((k) => k.includes('tenant-a'));
    const keyB = keysRead.find((k) => k.includes('tenant-b'));

    expect(keyA).toBe('email-tenant-a:inbox-creds');
    expect(keyB).toBe('email-tenant-b:inbox-creds');
    // Confirm no cross-tenant key access
    expect(keysRead.filter((k) => k.includes('tenant-a'))).not.toContain(keyB);
    expect(keysRead.filter((k) => k.includes('tenant-b'))).not.toContain(keyA);
  });

  // ---- Test 9: stop() disconnects IMAP + clears transport ------------------
  it('stop() calls IMAP logout and status returns to unpaired', async () => {
    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      moduleLoader: makeRealModuleLoader(),
      secretsGet: async () => JSON.stringify(VALID_CREDS),
      secretsSet: async () => undefined,
    });

    await child.start();
    expect(child.status).toBe('open');

    await child.stop(true);

    expect(mockImapLogoutCalled).toBe(true);
    expect(child.status).toBe('unpaired');
  });

  // ---- Test 10: health() returns ok=false when unpaired --------------------
  it('health() returns ok=false when unpaired', async () => {
    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      moduleLoader: makeRealModuleLoader(),
      secretsGet: async () => null,
      secretsSet: async () => undefined,
    });
    await child.start();

    const h = await child.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('status=unpaired');
  });

  // ---- Test 11: health() returns ok=true in degrade mode -------------------
  it('health() returns ok=true in degrade mode (child is running, just mocked)', async () => {
    const child = new EmailChild(makeCtx(), {
      account: 'test-account',
      moduleLoader: makeDegradeModuleLoader(),
      secretsGet: async () => null,
      secretsSet: async () => undefined,
    });
    await child.start();

    const h = await child.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('degrade-mode');
  });
});
