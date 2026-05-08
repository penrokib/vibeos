// =============================================================================
// rokibrain.app — EmailChild (Cycle 15)
// -----------------------------------------------------------------------------
// IMAP inbound (imapflow) + SMTP outbound (nodemailer) mesh child.
//
// Boot state: `unpaired` — child boots in unpaired state and emits `pair-needed`
// unless M12 secrets already hold credentials for the account.
//
// Credentials contract (JSON stored in M12 Keychain, key = `email-${account}-creds`):
//   { imapHost, imapPort, smtpHost, smtpPort, user, pass | oauthToken }
//   oauthToken is used as XOAUTH2 (Gmail-style) when present; falls back to pass.
//
// Degrade mode:
//   - If `imapflow` or `nodemailer` cannot be loaded → permanent degrade, status
//     stays `unpaired`, listChats/listMessages return stubs, send() refuses.
//   - No throw on missing modules — degrade is silent + labelled.
//
// Hardwalls:
//   - Creds ONLY via M12 secrets (Keychain). NEVER written to disk / plaintext.
//   - send() ALWAYS via SendPipeline (anti-ban gates). Blocked when unpaired.
//   - Tenant isolation: secret key is scoped as `email-${tenantId}:${account}-creds`.
//     Account names MUST NOT cross tenants — probed cred key includes tenant prefix.
//   - DO NOT modify anti-ban.ts, supervisor.ts, or base-child.ts.
// =============================================================================

import { EventEmitter } from 'node:events';
import { BaseMeshChild, type ChildContext } from '../../base-child';
import { withAntiBan } from '../../anti-ban';
import type {
  AntiBanVerdict,
  HealthStatus,
  SupervisorMessage,
} from '../../types';
import type { MeshChat, MeshMessage } from '../../../shared/ipc-contracts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Credentials stored in M12 secrets (value is JSON-serialised EmailCreds). */
export interface EmailCreds {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  user: string;
  /** Plain-text password. Mutually exclusive with oauthToken. */
  pass?: string;
  /** XOAUTH2 token (Gmail OAuth flow). Mutually exclusive with pass. */
  oauthToken?: string;
}

export interface EmailChildOptions {
  /** Logical account name, e.g. `gmail-rokib` or `outlook-personal`. */
  account: string;
  /**
   * Tenant ID for secret key isolation.  Defaults to `default`.
   * Secret key = `email-${tenantId}:${account}-creds`.
   */
  tenantId?: string;
  /**
   * Injectable secrets reader. Signature matches window.rokibrain.secrets.get /
   * M12 SecretsService daemon-side API.
   * Returns null when secret not found.
   */
  secretsGet?: (key: string) => Promise<string | null>;
  /** Injectable secrets writer (M12). */
  secretsSet?: (key: string, value: string) => Promise<void>;
  /**
   * Injectable module loader — for testing degrade mode without altering the
   * global module registry. Defaults to dynamic `import()`.
   * Return null from either loader to trigger degrade mode.
   */
  moduleLoader?: {
    loadImapFlow: () => Promise<{ ImapFlow: unknown } | null>;
    loadNodemailer: () => Promise<{ createTransport: unknown } | null>;
  };
}

/** Subset of connection status surfaced to the daemon + UI. */
export type EmailChildStatus = 'unpaired' | 'connecting' | 'open' | 'error';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class EmailAntiBanRefusedError extends Error {
  readonly verdict: AntiBanVerdict;
  constructor(verdict: AntiBanVerdict) {
    super(
      `email send refused by anti-ban gate: ${verdict.reasons?.join(', ') ?? 'unknown'}`,
    );
    this.name = 'EmailAntiBanRefusedError';
    this.verdict = verdict;
  }
}

export class EmailSendBlockedError extends Error {
  constructor(reason: string) {
    super(`email send blocked: ${reason}`);
    this.name = 'EmailSendBlockedError';
  }
}

// ---------------------------------------------------------------------------
// Module-level dynamic import wrappers (degrade-mode support)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of imapflow used by EmailChild.
 * Typed as `unknown` from dynamic import; we narrow to this interface.
 */
export interface ImapFlowLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  idle(): Promise<void | boolean>;
  on(evt: string, cb: (...args: unknown[]) => void): this;
  off(evt: string, cb: (...args: unknown[]) => void): this;
  authenticated: boolean;
  mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<unknown>;
  fetch(
    range: string,
    query: Record<string, boolean>,
  ): AsyncIterable<ImapFlowMessage>;
}

export interface ImapFlowMessage {
  uid: number;
  source?: Buffer;
  envelope?: {
    messageId?: string;
    subject?: string;
    from?: Array<{ name?: string; address?: string }>;
    date?: Date;
  };
  flags?: Set<string>;
  bodyParts?: Map<string, Buffer>;
}

interface ImapFlowCtor {
  new (opts: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass?: string; accessToken?: string };
    logger: false;
  }): ImapFlowLike;
}

interface NodemailerModule {
  createTransport(opts: unknown): NodemailerTransport;
}

interface NodemailerTransport {
  sendMail(opts: NodemailerSendOptions): Promise<{ messageId?: string }>;
  close?(): void;
}

interface NodemailerSendOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
}

// ---------------------------------------------------------------------------
// EmailChild
// ---------------------------------------------------------------------------

export class EmailChild extends BaseMeshChild {
  readonly account: string;
  private readonly tenantId: string;
  private readonly secretsGet: (key: string) => Promise<string | null>;
  private readonly secretsSet: (key: string, value: string) => Promise<void>;

  private _status: EmailChildStatus = 'unpaired';
  private _lastError: string | undefined;
  private _lastPollAt: string | undefined;
  private _degradeMode = false;

  /** Internal event emitter for IMAP IDLE new-message notifications. */
  private readonly _internalEmitter = new EventEmitter();

  /** Live imapflow client. */
  private _imap: ImapFlowLike | null = null;
  /** Nodemailer transport. */
  private _smtpTransport: NodemailerTransport | null = null;

  /** Guard to make start() idempotent. */
  private _started = false;
  /** Guard for stop() teardown path. */
  private _stopping = false;

  /** Dynamically loaded modules (null = not available = degrade). */
  private _ImapFlow: ImapFlowCtor | null = null;
  private _nodemailer: NodemailerModule | null = null;

  /** Stored creds for SMTP re-use after pair(). */
  private _creds: EmailCreds | null = null;

  /** Injectable module loader (for tests). */
  private readonly _moduleLoader: NonNullable<EmailChildOptions['moduleLoader']>;

  constructor(ctx: ChildContext, opts: EmailChildOptions) {
    super(ctx);
    this.account = opts.account;
    this.tenantId = opts.tenantId ?? 'default';
    this.secretsGet = opts.secretsGet ?? noopSecretsGet;
    this.secretsSet = opts.secretsSet ?? noopSecretsSet;
    this._moduleLoader = opts.moduleLoader ?? {
      loadImapFlow: () => import('imapflow').catch(() => null) as Promise<{ ImapFlow: unknown } | null>,
      loadNodemailer: () => import('nodemailer').catch(() => null) as Promise<{ createTransport: unknown } | null>,
    };
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Boot sequence:
   *   1. Try dynamic-import of imapflow + nodemailer.  Missing → degrade mode.
   *   2. Probe M12 secrets for stored creds.  Missing → unpaired + emit pair-needed.
   *   3. Creds found → connect IMAP → transition to `open`.
   * Idempotent (second call is a no-op).
   */
  override async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this._stopping = false;

    // --- 1. Load optional modules -------------------------------------------
    await this._loadModules();

    if (this._degradeMode) {
      this._status = 'unpaired';
      this.emit('started', {
        message: `email-child ${this.account} degrade-mode: imapflow/nodemailer not installed`,
      });
      this._internalEmitter.emit('pair-needed', { account: this.account, reason: 'degrade' });
      return;
    }

    // --- 2. Check for stored creds ------------------------------------------
    const creds = await this._loadCreds();
    if (!creds) {
      this._status = 'unpaired';
      this.emit('started', {
        message: `email-child ${this.account} unpaired (no creds in M12 secrets)`,
      });
      this._internalEmitter.emit('pair-needed', { account: this.account, reason: 'no-creds' });
      return;
    }

    // --- 3. Connect IMAP ----------------------------------------------------
    try {
      await this._connectImap(creds);
      this._status = 'open';
      this._creds = creds;
      this._lastPollAt = new Date().toISOString();
      this.emit('started', {
        message: `email-child ${this.account} open (IMAP connected)`,
      });
    } catch (err) {
      this._status = 'error';
      this._lastError = String(err);
      this.emit('started', {
        message: `email-child ${this.account} error on connect: ${this._lastError}`,
      });
    }
  }

  /**
   * Graceful stop: close IMAP connection + SMTP transport.
   * Resolves within 10 s per BaseMeshChild contract.
   */
  override async stop(_graceful: boolean): Promise<void> {
    this._stopping = true;
    try {
      if (this._imap) {
        await Promise.race([
          this._imap.logout().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
        ]);
        this._imap = null;
      }
      if (this._smtpTransport?.close) {
        this._smtpTransport.close();
        this._smtpTransport = null;
      }
    } catch {
      // Never block stop
    }
    this._status = 'unpaired';
    this._started = false;
    this.emit('exited', { message: `email-child ${this.account} stopped` });
  }

  /** Health probe — called every 30s by Supervisor. */
  override async health(): Promise<HealthStatus> {
    if (this._degradeMode) {
      return {
        ok: true,
        detail: `email-child ${this.account} degrade-mode: imapflow/nodemailer not installed`,
        metrics: { degradeMode: 1, status: 0 },
      };
    }
    return {
      ok: this._status === 'open',
      detail: `email-child ${this.account} status=${this._status} lastPoll=${this._lastPollAt ?? 'never'}${this._lastError ? ` error=${this._lastError}` : ''}`,
      metrics: {
        degradeMode: 0,
        connected: this._status === 'open' ? 1 : 0,
        lastPollTs: this._lastPollAt ? new Date(this._lastPollAt).getTime() : 0,
      },
    };
  }

  override async handleSupervisorMessage(msg: SupervisorMessage): Promise<void> {
    if (msg.kind === 'shutdown') {
      await this.stop(msg.graceful);
    }
  }

  // ---- pairing API ----------------------------------------------------------

  /**
   * Provide credentials to pair the account.
   * Stores creds in M12 secrets, attempts IMAP connection, transitions to `open`.
   * Tenant-scoped: key = `email-${tenantId}:${account}-creds`.
   */
  async pair(creds: EmailCreds): Promise<{ success: boolean; error?: string }> {
    if (this._degradeMode) {
      return { success: false, error: 'degrade-mode: imapflow/nodemailer not installed' };
    }
    try {
      // Validate creds shape
      if (!creds.imapHost || !creds.smtpHost || !creds.user) {
        return { success: false, error: 'imapHost, smtpHost, and user are required' };
      }
      if (!creds.pass && !creds.oauthToken) {
        return { success: false, error: 'either pass or oauthToken is required' };
      }

      // Test connection before persisting
      await this._connectImap(creds);

      // Persist to M12 (Keychain)
      await this.secretsSet(this._secretKey(), JSON.stringify(creds));

      this._status = 'open';
      this._creds = creds;
      this._lastPollAt = new Date().toISOString();
      this._lastError = undefined;
      return { success: true };
    } catch (err) {
      this._status = 'unpaired';
      const msg = String(err);
      this._lastError = msg;
      return { success: false, error: msg };
    }
  }

  // ---- Mesh API -------------------------------------------------------------

  /**
   * List inbox + sent folders as MeshChat-shaped objects.
   * Each folder maps to a "chat" (folder name = chat.jid + chat.name).
   */
  async listChats(limit = 50): Promise<MeshChat[]> {
    if (this._degradeMode) {
      return [degradeChat(this.account)];
    }
    if (this._status !== 'open' || !this._imap) {
      return [];
    }
    try {
      // For v1: return INBOX + Sent as synthetic chats
      const folders = ['INBOX', 'Sent'];
      const chats: MeshChat[] = [];
      for (const folder of folders.slice(0, limit)) {
        chats.push({
          jid: folder,
          name: folder,
          last_message_time: Math.floor(Date.now() / 1000),
          last_message: '',
          unread_count: 0,
        });
      }
      this._lastPollAt = new Date().toISOString();
      return chats;
    } catch (err) {
      this._lastError = String(err);
      return [];
    }
  }

  /**
   * Fetch messages from the given folder/thread (chatId = IMAP folder path).
   * Returns newest `limit` messages as MeshMessage[].
   */
  async listMessages(chatId: string, limit = 50): Promise<MeshMessage[]> {
    if (this._degradeMode || this._status !== 'open' || !this._imap) {
      return [];
    }
    try {
      await this._imap.mailboxOpen(chatId, { readOnly: true });
      const msgs: MeshMessage[] = [];

      const fetchRange = `${Math.max(1, limit)}:*`;
      for await (const msg of this._imap.fetch(fetchRange, {
        envelope: true,
        flags: true,
      })) {
        const env = msg.envelope;
        const from = env?.from?.[0];
        msgs.push({
          id: String(msg.uid),
          chat_jid: chatId,
          sender: from?.address ?? from?.name ?? '',
          content: env?.subject ?? '',
          timestamp: env?.date ? Math.floor(env.date.getTime() / 1000) : 0,
          is_from_me: 0,
          media_type: '',
        });
        if (msgs.length >= limit) break;
      }
      this._lastPollAt = new Date().toISOString();
      return msgs;
    } catch (err) {
      this._lastError = String(err);
      return [];
    }
  }

  /**
   * Send an email via SMTP (nodemailer). ALWAYS goes through anti-ban gate.
   * Throws EmailSendBlockedError if status !== 'open'.
   * Throws EmailAntiBanRefusedError if gate refuses.
   */
  async send(recipient: string, text: string): Promise<void> {
    if (this._degradeMode) {
      throw new EmailSendBlockedError('degrade-mode: imapflow/nodemailer not installed');
    }
    if (this._status !== 'open') {
      throw new EmailSendBlockedError(`status=${this._status} — must be paired first`);
    }

    const result = await withAntiBan(
      {
        childId: this.id,
        action: 'send',
        accountId: this.account,
        meta: {
          recipientHash: hashRecipient(recipient),
          bodyLen: text.length,
        },
      },
      async () => {
        const transport = await this._getSmtpTransport();
        await transport.sendMail({
          from: this._creds?.user ?? '',
          to: recipient,
          subject: 'Re: ',
          text,
        });
      },
    );

    if (!result.allowed) {
      throw new EmailAntiBanRefusedError(result.verdict);
    }
  }

  // ---- IMAP IDLE subscription -----------------------------------------------

  /**
   * Subscribe to new-mail push events from IMAP IDLE.
   * Callback receives a MeshMessage stub when IDLE delivers a new-exists event.
   * Returns an unsubscribe function.
   */
  onNewMail(cb: (msg: MeshMessage) => void): () => void {
    this._internalEmitter.on('new-mail', cb);
    return () => this._internalEmitter.off('new-mail', cb);
  }

  /** Subscribe to pair-needed events. */
  onPairNeeded(cb: (info: { account: string; reason: string }) => void): () => void {
    this._internalEmitter.on('pair-needed', cb);
    return () => this._internalEmitter.off('pair-needed', cb);
  }

  // ---- accessors (tests / UI) -----------------------------------------------

  get status(): EmailChildStatus { return this._status; }
  get degradeMode(): boolean { return this._degradeMode; }
  get lastError(): string | undefined { return this._lastError; }
  get lastPollAt(): string | undefined { return this._lastPollAt; }

  // ---- private helpers -------------------------------------------------------

  private _secretKey(): string {
    // Tenant-scoped key — no cross-tenant leakage.
    return `email-${this.tenantId}:${this.account}-creds`;
  }

  private async _loadCreds(): Promise<EmailCreds | null> {
    try {
      const raw = await this.secretsGet(this._secretKey());
      if (!raw) return null;
      return JSON.parse(raw) as EmailCreds;
    } catch {
      return null;
    }
  }

  private async _loadModules(): Promise<void> {
    try {
      const imapflowMod = await this._moduleLoader.loadImapFlow();
      const nodemailerMod = await this._moduleLoader.loadNodemailer();

      if (!imapflowMod?.ImapFlow || !nodemailerMod?.createTransport) {
        this._degradeMode = true;
        return;
      }
      this._ImapFlow = imapflowMod.ImapFlow as unknown as ImapFlowCtor;
      this._nodemailer = nodemailerMod as unknown as NodemailerModule;
    } catch {
      this._degradeMode = true;
    }
  }

  private async _connectImap(creds: EmailCreds): Promise<void> {
    if (!this._ImapFlow) {
      throw new Error('imapflow not available (degrade mode)');
    }

    // Tear down any existing connection
    if (this._imap) {
      await this._imap.logout().catch(() => undefined);
      this._imap = null;
    }

    const imap = new this._ImapFlow({
      host: creds.imapHost,
      port: creds.imapPort,
      secure: creds.imapPort === 993,
      auth: creds.oauthToken
        ? { user: creds.user, accessToken: creds.oauthToken }
        : { user: creds.user, pass: creds.pass ?? '' },
      logger: false,
    });

    await imap.connect();
    this._imap = imap;

    // Wire IMAP IDLE "exists" events → MeshMessage emissions
    imap.on('exists', (data: unknown) => {
      // When IDLE receives an "exists" update, emit a synthetic stub event.
      const uid = (data as { count?: number })?.count ?? 0;
      const meshMsg: MeshMessage = {
        id: `idle-${uid}-${Date.now()}`,
        chat_jid: 'INBOX',
        sender: '',
        content: '(new message — fetch to read)',
        timestamp: Math.floor(Date.now() / 1000),
        is_from_me: 0,
        media_type: '',
      };
      this._internalEmitter.emit('new-mail', meshMsg);
      // Also emit as a ChildEvent so the Supervisor/daemon can observe
      this.emit('health', { data: { newMailEvent: true, uid } });
    });

    imap.on('error', (err: unknown) => {
      if (!this._stopping) {
        this._lastError = String(err);
        this._status = 'error';
        this.emit('crashed', { message: `IMAP error: ${this._lastError}` });
      }
    });
  }

  private async _getSmtpTransport(): Promise<NodemailerTransport> {
    if (this._smtpTransport) return this._smtpTransport;
    if (!this._nodemailer || !this._creds) {
      throw new Error('nodemailer not available or no creds');
    }
    const creds = this._creds;
    const authOpts = creds.oauthToken
      ? {
          type: 'OAuth2' as const,
          user: creds.user,
          accessToken: creds.oauthToken,
        }
      : {
          user: creds.user,
          pass: creds.pass ?? '',
        };

    this._smtpTransport = this._nodemailer.createTransport({
      host: creds.smtpHost,
      port: creds.smtpPort,
      secure: creds.smtpPort === 465,
      auth: authOpts,
    });
    return this._smtpTransport;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function degradeChat(account: string): MeshChat {
  return {
    jid: 'degrade',
    name: `Email (${account}) — install imapflow + nodemailer to activate`,
    last_message_time: 0,
    last_message: '',
    unread_count: 0,
  };
}

/**
 * Cheap one-way hash of recipient address so anti-ban meta never logs cleartext.
 */
function hashRecipient(addr: string): string {
  let h = 5381;
  for (let i = 0; i < addr.length; i++) {
    h = ((h << 5) + h) ^ addr.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16);
}

async function noopSecretsGet(_key: string): Promise<string | null> {
  return null;
}

async function noopSecretsSet(_key: string, _value: string): Promise<void> {
  // no-op
}
