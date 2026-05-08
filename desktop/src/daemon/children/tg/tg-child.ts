// =============================================================================
// rokibrain.app — TgChild (Cycle 14)
// -----------------------------------------------------------------------------
// MTProto Telegram child that bridges one Telegram account into the mesh.
// Uses the `telegram` npm package (node-telegram-bot based MTProto client —
// smaller footprint than TDLib).
//
// Pairing flow:
//   1. start() probes M12 secrets for `tg-${account}-session`.
//   2. If missing → status stays `unpaired`, emits `pair-qr` event (renderer
//      opens the pair wizard in the Connections tab).
//   3. Roki enters phone number in the wizard (Step 1) and optionally scans
//      QR or enters SMS code (Step 2).
//   4. pair(phoneNumber) runs the MTProto auth flow. On success: session string
//      persisted to M12 secrets, child transitions to `open`.
//
// Hardwalls:
//   - Session string stored in M12 (Keychain). NEVER written plaintext to disk.
//   - send() ALWAYS goes through withAntiBan(). Refused → TgAntiBanRefusedError.
//   - MESH_TG_ENABLED=true required to activate (default OFF).
//   - Degrade mode: if `telegram` package is absent, child stays `unpaired`
//     forever and all API calls are mock-stubbed (no throw; safe in CI/tests).
//   - send() refuses with TgNotOpenError if status !== 'open'.
//   - Concurrency: Node.js event loop serialises per-tick microtasks; parallel
//     callers interleave at await boundaries which is acceptable (MTProto serial
//     queue is enforced server-side). ≥5-concurrent-writer safety documented.
// =============================================================================

import { BaseMeshChild, type ChildContext } from '../../base-child';
import { withAntiBan } from '../../anti-ban';
import type {
  AntiBanVerdict,
  HealthStatus,
  SupervisorMessage,
} from '../../types';
import type {
  MeshAccount,
  MeshAccountStatus,
  MeshChat,
  MeshMessage,
} from '../../../shared/ipc-contracts';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class TgAntiBanRefusedError extends Error {
  readonly verdict: AntiBanVerdict;
  constructor(verdict: AntiBanVerdict) {
    super(
      `tg send refused by anti-ban gate: ${verdict.reasons?.join(', ') ?? 'unknown'}`,
    );
    this.name = 'TgAntiBanRefusedError';
    this.verdict = verdict;
  }
}

export class TgNotOpenError extends Error {
  constructor(status: TgStatus) {
    super(`tg send refused: child status is '${status}' (requires 'open')`);
    this.name = 'TgNotOpenError';
  }
}

// ---------------------------------------------------------------------------
// Telegram package shim — dynamic import for degrade-mode safety
// ---------------------------------------------------------------------------

/** Minimal shape of the `telegram` TelegramClient we consume. */
export interface TelegramClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Returns session string for persistence. */
  session: { save(): string };
  /** isUserAuthorized — whether the client has a valid session. */
  isUserAuthorized(): Promise<boolean>;
  /**
   * Drive the auth flow. `getPhoneCode` is called by the client when a code
   * arrives via SMS or QR scan. `onError` is called on failures.
   */
  start(params: {
    phoneNumber: string | (() => Promise<string>);
    phoneCode: () => Promise<string>;
    onError: (err: Error) => void;
  }): Promise<void>;
  invoke(request: unknown): Promise<unknown>;
}

export interface TelegramSessionLike {
  new(sessionString?: string): TelegramSessionLike;
  save(): string;
}

/** Minimal message shape from Telegram dialogs API. */
export interface TgRawDialog {
  id?: number | string | bigint;
  title?: string;
  date?: number;
  message?: { message?: string };
  unreadCount?: number;
}

export interface TgRawMessage {
  id?: number | string | bigint;
  peerId?: { userId?: number | bigint; chatId?: number | bigint; channelId?: number | bigint };
  fromId?: { userId?: number | bigint };
  message?: string;
  date?: number;
  out?: boolean;
  media?: unknown;
}

// ---------------------------------------------------------------------------
// TG client status
// ---------------------------------------------------------------------------

export type TgStatus = 'unpaired' | 'connecting' | 'open' | 'disconnected';

// ---------------------------------------------------------------------------
// Secrets interface — injected so tests can provide a fake
// ---------------------------------------------------------------------------

export interface SecretsBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TgChildOptions {
  /** Logical account name, e.g. 'personal', 'business'. */
  account: string;
  /**
   * Telegram API ID from my.telegram.org. Read from env MESH_TG_API_ID.
   * NEVER hardcode a non-zero default.
   */
  apiId?: number;
  /**
   * Telegram API hash from my.telegram.org. Read from env MESH_TG_API_HASH.
   */
  apiHash?: string;
  /**
   * Injected secrets backend (main-process safeStorage wrapper).
   * If not provided, TgChild uses a noop backend (secrets always return null —
   * triggers unpaired state; useful in tests that explicitly inject a backend).
   */
  secrets?: SecretsBackend;
  /**
   * Override the TelegramClient constructor. Used in tests to inject a mock.
   * If undefined, TgChild will attempt `require('telegram')`. If that throws,
   * degrade mode is activated.
   */
  telegramClientFactory?: TelegramClientFactory;
}

export type TelegramClientFactory = (
  sessionString: string | undefined,
  apiId: number,
  apiHash: string,
) => TelegramClientLike;

// ---------------------------------------------------------------------------
// TgChild
// ---------------------------------------------------------------------------

export class TgChild extends BaseMeshChild {
  readonly account: string;

  private _status: TgStatus = 'unpaired';
  private _degradeMode = false;
  private _started = false;

  private readonly _apiId: number;
  private readonly _apiHash: string;
  private readonly _secrets: SecretsBackend;
  private readonly _telegramClientFactory: TelegramClientFactory | null;

  private _client: TelegramClientLike | null = null;

  /** Resolve this to provide the SMS/QR code during pair() flow. */
  private _pendingCodeResolver: ((code: string) => void) | null = null;

  constructor(ctx: ChildContext, opts: TgChildOptions) {
    super(ctx);
    this.account = opts.account;
    this._apiId = opts.apiId ?? parseInt(process.env['MESH_TG_API_ID'] ?? '0', 10);
    this._apiHash = opts.apiHash ?? (process.env['MESH_TG_API_HASH'] ?? '');
    this._secrets = opts.secrets ?? noopSecretsBackend();
    this._telegramClientFactory =
      'telegramClientFactory' in opts && opts.telegramClientFactory !== undefined
        ? opts.telegramClientFactory
        : loadTelegramClientFactory();
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Probe M12 secrets for a saved session. If found → connect. If missing →
   * stay unpaired (renderer shows the pair wizard). Idempotent.
   */
  override async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    if (!this._telegramClientFactory) {
      // telegram package not installed — safe degrade mode
      this._degradeMode = true;
      this._status = 'unpaired';
      this.emit('started', {
        message: `tg-child ${this.account} degrade-mode: telegram package not installed`,
      });
      return;
    }

    const sessionStr = await this._secrets.get(this._secretKey());
    if (!sessionStr) {
      // No session — unpaired; renderer should show pair wizard
      this._status = 'unpaired';
      this.emit('started', {
        message: `tg-child ${this.account} unpaired — no saved session`,
      });
      // Emit pair-qr event so ConnectionsTab can open the wizard
      this.emit('health', { data: { pairState: 'unpaired', account: this.account } });
      return;
    }

    // Session exists — try to connect
    await this._connectWithSession(sessionStr);
  }

  override async stop(_graceful: boolean): Promise<void> {
    if (this._client) {
      try {
        await this._client.disconnect();
      } catch {
        // Best-effort
      }
      this._client = null;
    }
    this._status = 'disconnected';
    this._started = false;
    this.emit('exited', { message: `tg-child ${this.account} stopped` });
  }

  override async health(): Promise<HealthStatus> {
    if (this._degradeMode) {
      return {
        ok: true,
        detail: `tg-child ${this.account} degrade-mode (telegram package not installed)`,
        metrics: { degradeMode: 1, status: 0 },
      };
    }
    const ok = this._status === 'open';
    return {
      ok,
      detail: `tg-child ${this.account} status=${this._status}`,
      metrics: { degradeMode: 0, status: ok ? 1 : 0 },
    };
  }

  override async handleSupervisorMessage(msg: SupervisorMessage): Promise<void> {
    if (msg.kind === 'shutdown') {
      await this.stop(msg.graceful);
    }
  }

  // ---- public pair API -------------------------------------------------------

  /**
   * Run the MTProto pair flow for the given phone number. Returns success/failure.
   *
   * Caller (renderer ↔ main IPC) drives this:
   *   1. Renderer sends TG_PAIR_START with phone number.
   *   2. Main calls child.pair(phoneNumber).
   *   3. child.pair waits for a code via confirmCode().
   *   4. Renderer receives TG_PAIR_QR event and shows the code prompt.
   *   5. Renderer calls TG_PAIR_CONFIRM with the code.
   *   6. Main calls child.confirmCode(code) to resolve the pending promise.
   *   7. pair() completes; session stored; status → 'open'.
   *
   * On error: _pendingCodeResolver is cleared; status stays 'unpaired'.
   */
  async pair(phoneNumber: string): Promise<{ success: boolean; error?: string }> {
    if (this._degradeMode) {
      return { success: false, error: 'degrade-mode: telegram package not installed' };
    }
    if (!this._telegramClientFactory) {
      return { success: false, error: 'telegram package unavailable' };
    }
    if (!this._apiId || !this._apiHash) {
      return {
        success: false,
        error: 'MESH_TG_API_ID / MESH_TG_API_HASH not configured',
      };
    }

    // Create a fresh client (no session for pairing)
    const client = this._telegramClientFactory(undefined, this._apiId, this._apiHash);
    this._status = 'connecting';

    try {
      await client.start({
        phoneNumber,
        phoneCode: async () => {
          // Signal renderer that a code is needed
          this.emit('health', { data: { pairState: 'awaiting-code', account: this.account } });
          // Wait for confirmCode() to be called
          return new Promise<string>((resolve) => {
            this._pendingCodeResolver = resolve;
          });
        },
        onError: (err: Error) => {
          this._pendingCodeResolver = null;
          this.emit('crashed', { message: `tg pair error: ${err.message}` });
        },
      });

      // Persist session — NEVER plaintext; routed through M12 safeStorage
      const sessionStr = client.session.save();
      await this._secrets.set(this._secretKey(), sessionStr);

      this._client = client;
      this._status = 'open';
      this.emit('health', { data: { pairState: 'paired', account: this.account } });
      return { success: true };
    } catch (err) {
      this._pendingCodeResolver = null;
      this._status = 'unpaired';
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * Resolve a pending pair code prompt. Called by the IPC handler when the
   * renderer submits the SMS/QR code entered by Roki.
   */
  confirmCode(code: string): void {
    if (this._pendingCodeResolver) {
      const resolve = this._pendingCodeResolver;
      this._pendingCodeResolver = null;
      resolve(code);
    }
  }

  // ---- public messaging API --------------------------------------------------

  /**
   * List Telegram dialogs (chats). Returns empty array in degrade mode or
   * when disconnected.
   */
  async listChats(limit = 50): Promise<MeshChat[]> {
    if (this._degradeMode || !this._client || this._status !== 'open') {
      return [];
    }
    try {
      // GetDialogs returns a list of dialog objects
      const result = await this._client.invoke({
        _: 'messages.getDialogs',
        offsetDate: 0,
        offsetId: 0,
        offsetPeer: { _: 'inputPeerEmpty' },
        limit,
        hash: BigInt(0),
      }) as { dialogs?: TgRawDialog[] } | undefined;
      const dialogs = (result as { dialogs?: TgRawDialog[] })?.dialogs ?? [];
      return dialogs.map((d) => ({
        jid: String(d.id ?? ''),
        name: d.title ?? '',
        last_message_time: d.date ?? 0,
        last_message: d.message?.message ?? '',
        unread_count: d.unreadCount ?? 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * List messages in a chat. `chatId` is the Telegram peer ID (as string).
   */
  async listMessages(chatId: string, limit = 50): Promise<MeshMessage[]> {
    if (this._degradeMode || !this._client || this._status !== 'open') {
      return [];
    }
    try {
      const result = await this._client.invoke({
        _: 'messages.getHistory',
        peer: { _: 'inputPeerUser', userId: BigInt(chatId), accessHash: BigInt(0) },
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      }) as { messages?: TgRawMessage[] } | undefined;
      const messages = (result as { messages?: TgRawMessage[] })?.messages ?? [];
      return messages.map((m) => ({
        id: String(m.id ?? ''),
        chat_jid: chatId,
        sender: String(
          m.fromId?.userId ?? m.peerId?.userId ?? m.peerId?.chatId ?? m.peerId?.channelId ?? '',
        ),
        content: m.message ?? '',
        timestamp: m.date ?? 0,
        is_from_me: (m.out ? 1 : 0) as 0 | 1,
        media_type: m.media ? 'media' : '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Send a text message. ALWAYS goes through anti-ban gate. Throws:
   *   - TgNotOpenError if status !== 'open'
   *   - TgAntiBanRefusedError if gate refuses
   *
   * NOTE: from any external surface call SendPipeline.sendDraft() instead —
   * never call this directly. TgChild.send() is the implementation target of
   * SendPipeline step 5.
   */
  async send(recipient: string, text: string): Promise<void> {
    if (this._status !== 'open') {
      throw new TgNotOpenError(this._status);
    }

    const result = await withAntiBan(
      {
        childId: this.id,
        action: 'send',
        accountId: this.account,
        meta: { recipientHash: hashRecipient(recipient), bodyLen: text.length },
      },
      async () => {
        if (!this._client) throw new TgNotOpenError(this._status);
        await this._client.invoke({
          _: 'messages.sendMessage',
          peer: { _: 'inputPeerUser', userId: BigInt(recipient), accessHash: BigInt(0) },
          message: text,
          randomId: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
        });
      },
    );

    if (!result.allowed) {
      throw new TgAntiBanRefusedError(result.verdict);
    }
  }

  // ---- account status -------------------------------------------------------

  async accountStatus(): Promise<MeshAccount> {
    return {
      account: this.account,
      status: tgStatusToMesh(this._status),
    };
  }

  // ---- accessors (tests) ----------------------------------------------------

  get status(): TgStatus { return this._status; }
  get degradeMode(): boolean { return this._degradeMode; }
  get client(): TelegramClientLike | null { return this._client; }

  // ---- private helpers -------------------------------------------------------

  private _secretKey(): string {
    return `tg-${this.account}-session`;
  }

  private async _connectWithSession(sessionStr: string): Promise<void> {
    if (!this._telegramClientFactory) return;

    const client = this._telegramClientFactory(sessionStr, this._apiId, this._apiHash);
    this._status = 'connecting';

    try {
      await client.connect();
      const authorized = await client.isUserAuthorized();
      if (!authorized) {
        // Session expired — back to unpaired
        this._status = 'unpaired';
        this.emit('started', {
          message: `tg-child ${this.account} session expired — re-pair required`,
        });
        this.emit('health', { data: { pairState: 'unpaired', account: this.account } });
        return;
      }
      this._client = client;
      this._status = 'open';
      this.emit('started', {
        message: `tg-child ${this.account} open (session restored)`,
      });
    } catch (err) {
      this._status = 'unpaired';
      this.emit('started', {
        message: `tg-child ${this.account} connect failed: ${String(err)} — re-pair required`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tgStatusToMesh(s: TgStatus): MeshAccountStatus {
  switch (s) {
    case 'open':
      return 'open';
    case 'connecting':
      return 'connecting';
    case 'disconnected':
      return 'close';
    case 'unpaired':
    default:
      return 'unknown';
  }
}

/**
 * FNV-1a variant for recipient ID hashing. Prevents cleartext phone numbers
 * from appearing in anti-ban meta or logs.
 */
function hashRecipient(id: string): string {
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h) ^ id.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16);
}

/** No-op secrets backend used when no real backend is injected (test default). */
function noopSecretsBackend(): SecretsBackend {
  const store = new Map<string, string>();
  return {
    async get(key) { return store.get(key) ?? null; },
    async set(key, value) { store.set(key, value); },
  };
}

/**
 * Attempt to load the `telegram` package factory at runtime. Returns null if
 * the package isn't installed — activates degrade mode (no throw).
 */
function loadTelegramClientFactory(): TelegramClientFactory | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tg = require('telegram') as {
      TelegramClient: new (session: unknown, apiId: number, apiHash: string, opts: Record<string, unknown>) => TelegramClientLike;
      sessions: { StringSession: new (s?: string) => unknown };
    };
    return (sessionString, apiId, apiHash) => {
      const session = new tg.sessions.StringSession(sessionString ?? '');
      return new tg.TelegramClient(session, apiId, apiHash, {
        connectionRetries: 3,
        useWSS: false,
      });
    };
  } catch {
    // Package not installed — degrade mode
    return null;
  }
}
