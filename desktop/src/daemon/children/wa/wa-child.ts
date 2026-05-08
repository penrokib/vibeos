// =============================================================================
// rokibrain.app — WaChild (M04 v1)
// -----------------------------------------------------------------------------
// Proxy child that forwards WhatsApp operations to the existing wa-multi-server
// REST backend at http://localhost:8086 (configurable via MESH_WA_BASE_URL).
//
// v1 ships as a pure proxy (low risk, no Baileys dependency). v1.1 ports
// Baileys directly into the daemon process.
//
// Hardwalls (per design §3 + feedback-wa-mcp-robust.md):
//   - ALL send() calls go through withAntiBan() — code-enforced, not
//     prompt-enforced. A refused verdict throws WaAntiBanRefusedError so the
//     caller knows the action was blocked (not silently dropped).
//   - Base URL is env-only (MESH_WA_BASE_URL). No committed default value.
//   - Renderer never gets raw stdout/stderr — use ChildLogger (via Supervisor).
//   - stop() in v1 is a no-op for proxy mode (wa-multi-server is externally
//     managed). v1.1 will own the Baileys process lifecycle.
// =============================================================================

import { BaseMeshChild, type ChildContext } from '../../base-child';
import { withAntiBan } from '../../anti-ban';
import type {
  AntiBanVerdict,
  HealthStatus,
  SupervisorMessage,
} from '../../types';
import type { MeshAccount, MeshAccountStatus, MeshChat, MeshMessage } from '../../../shared/ipc-contracts';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class WaAntiBanRefusedError extends Error {
  readonly verdict: AntiBanVerdict;
  constructor(verdict: AntiBanVerdict) {
    super(
      `wa send refused by anti-ban gate: ${verdict.reasons?.join(', ') ?? 'unknown'}`,
    );
    this.name = 'WaAntiBanRefusedError';
    this.verdict = verdict;
  }
}

// ---------------------------------------------------------------------------
// wa-multi-server response shapes (minimal — only fields WaChild consumes)
// ---------------------------------------------------------------------------

export interface WaStatusResponse {
  /** "open" | "connecting" | "close" */
  status: string;
  /** wa-multi-server instance/account name */
  name?: string;
}

export interface WaChatsResponse {
  chats?: RawWaChat[];
  data?: RawWaChat[];
}

export interface RawWaChat {
  id?: string;
  jid?: string;
  name?: string;
  last_message_time?: number;
  lastMessageTime?: number;
  last_message?: string;
  lastMessage?: string;
  unread_count?: number;
  unreadCount?: number;
}

export interface WaMessagesResponse {
  messages?: RawWaMessage[];
  data?: RawWaMessage[];
}

export interface RawWaMessage {
  id?: string;
  key?: { id?: string };
  chat_jid?: string;
  chatJid?: string;
  sender?: string;
  content?: string;
  body?: string;
  timestamp?: number;
  messageTimestamp?: number;
  is_from_me?: 0 | 1 | boolean;
  fromMe?: boolean;
  media_type?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WaChildOptions {
  /** Logical account name — 'personal' | 'business' | 'malaysia' | etc. */
  account: string;
  /**
   * Base URL of the wa-multi-server REST backend.
   * Defaults to env MESH_WA_BASE_URL, then http://localhost:8086.
   * Do NOT hardcode non-localhost values here.
   */
  baseUrl?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// WaChild
// ---------------------------------------------------------------------------

export class WaChild extends BaseMeshChild {
  readonly account: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private _connected = false;

  constructor(ctx: ChildContext, opts: WaChildOptions) {
    super(ctx);
    this.account = opts.account;
    // Env override — never a hardcoded non-localhost URL in v1
    this.baseUrl = (
      opts.baseUrl ??
      process.env['MESH_WA_BASE_URL'] ??
      'http://localhost:8086'
    ).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Probe /status for the bound account. If status is 'open', transition to
   * connected. Idempotent: calling twice while already running is a no-op.
   */
  override async start(): Promise<void> {
    if (this._connected) return;
    const status = await this.probeStatus();
    if (status === 'open') {
      this._connected = true;
      this.emit('started', { message: `wa-child ${this.account} open` });
    } else {
      // Not yet paired — report started (pairing) but stay _connected=false
      // so health() returns ok=false until the session comes up.
      this.emit('started', {
        message: `wa-child ${this.account} pairing (status=${status})`,
      });
    }
  }

  /**
   * Stop — v1 proxy mode: wa-multi-server is externally managed, so we just
   * mark ourselves disconnected. v1.1 will SIGTERM the Baileys sub-process.
   */
  override async stop(_graceful: boolean): Promise<void> {
    this._connected = false;
    this.emit('exited', { message: `wa-child ${this.account} proxy stopped` });
  }

  /**
   * Health probe — called every 30s by Supervisor. Re-checks /status against
   * the backend so UI shows live connection state.
   */
  override async health(): Promise<HealthStatus> {
    try {
      const status = await this.probeStatus();
      const ok = status === 'open';
      this._connected = ok;
      return {
        ok,
        detail: `wa-multi-server account=${this.account} status=${status}`,
        metrics: { connected: ok ? 1 : 0 },
      };
    } catch (err) {
      this._connected = false;
      return {
        ok: false,
        detail: `wa-multi-server unreachable: ${String(err)}`,
        metrics: { connected: 0 },
      };
    }
  }

  override async handleSupervisorMessage(msg: SupervisorMessage): Promise<void> {
    if (msg.kind === 'shutdown') {
      await this.stop(msg.graceful);
    }
    // pause / resume / health-probe / init: handled passively in v1
  }

  // ---- public proxy API (daemon-side only) ----------------------------------

  /** List chats for this account. Calls GET /chats/<account>?limit=<n>. */
  async listChats(limit = 50): Promise<MeshChat[]> {
    const url = `${this.baseUrl}/chats/${encodeURIComponent(this.account)}?limit=${limit}`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url);
    } catch (err) {
      throw new Error(`wa-multi-server unreachable: ${String(err)}`);
    }
    if (!resp.ok) {
      throw new Error(`wa-multi-server /chats returned ${resp.status}`);
    }
    const body = (await resp.json()) as WaChatsResponse;
    const raw = body.chats ?? body.data ?? [];
    return raw.map((c) => ({
      jid: c.jid ?? c.id ?? '',
      name: c.name ?? '',
      last_message_time: c.last_message_time ?? c.lastMessageTime ?? 0,
      last_message: c.last_message ?? c.lastMessage ?? '',
      unread_count: c.unread_count ?? c.unreadCount ?? 0,
    }));
  }

  /**
   * List messages for a chat. Calls GET /messages/<account>/<chatJid>?limit=<n>.
   */
  async listMessages(chatJid: string, limit = 50): Promise<MeshMessage[]> {
    const url = `${this.baseUrl}/messages/${encodeURIComponent(this.account)}/${encodeURIComponent(chatJid)}?limit=${limit}`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url);
    } catch (err) {
      throw new Error(`wa-multi-server unreachable: ${String(err)}`);
    }
    if (!resp.ok) {
      throw new Error(`wa-multi-server /messages returned ${resp.status}`);
    }
    const body = (await resp.json()) as WaMessagesResponse;
    const raw = body.messages ?? body.data ?? [];
    return raw.map((m) => {
      const fromMe = m.is_from_me !== undefined
        ? (m.is_from_me === true || m.is_from_me === 1 ? 1 : 0)
        : (m.fromMe ? 1 : 0);
      return {
        id: m.id ?? m.key?.id ?? '',
        chat_jid: m.chat_jid ?? m.chatJid ?? chatJid,
        sender: m.sender ?? '',
        content: m.content ?? m.body ?? '',
        timestamp: m.timestamp ?? m.messageTimestamp ?? 0,
        is_from_me: fromMe as 0 | 1,
        media_type: m.media_type ?? '',
      };
    });
  }

  /**
   * Send a message. ALWAYS goes through the anti-ban gate. Throws
   * WaAntiBanRefusedError if the gate refuses.
   *
   * Calls POST /send/<account> with JSON { recipient, message }.
   */
  async send(recipient: string, text: string): Promise<void> {
    const result = await withAntiBan(
      {
        childId: this.id,
        action: 'send',
        accountId: this.account,
        meta: { recipientHash: hashRecipient(recipient), bodyLen: text.length },
      },
      async () => {
        const url = `${this.baseUrl}/send/${encodeURIComponent(this.account)}`;
        let resp: Response;
        try {
          resp = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient, message: text }),
          });
        } catch (err) {
          throw new Error(`wa-multi-server unreachable: ${String(err)}`);
        }
        if (!resp.ok) {
          throw new Error(`wa-multi-server /send returned ${resp.status}`);
        }
      },
    );

    if (!result.allowed) {
      throw new WaAntiBanRefusedError(result.verdict);
    }
  }

  // ---- account status (used by Connections + Mesh UI) -----------------------

  /**
   * Returns a MeshAccount snapshot for the Connections panel.
   */
  async accountStatus(): Promise<MeshAccount> {
    try {
      const status = await this.probeStatus();
      return {
        account: this.account,
        status: statusToMesh(status),
      };
    } catch {
      return { account: this.account, status: 'unknown' };
    }
  }

  // ---- private helpers -------------------------------------------------------

  private async probeStatus(): Promise<string> {
    const url = `${this.baseUrl}/status`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url);
    } catch (err) {
      throw new Error(`wa-multi-server unreachable: ${String(err)}`);
    }
    if (!resp.ok) {
      throw new Error(`wa-multi-server /status returned ${resp.status}`);
    }
    const body = (await resp.json()) as WaStatusResponse | WaStatusResponse[];
    // wa-multi-server may return a single object or an array per account
    if (Array.isArray(body)) {
      const entry = body.find((a) => a.name === this.account);
      return entry?.status ?? 'unknown';
    }
    return (body as WaStatusResponse).status ?? 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusToMesh(raw: string): MeshAccountStatus {
  switch (raw) {
    case 'open':
      return 'open';
    case 'connecting':
      return 'connecting';
    case 'close':
      return 'close';
    default:
      return 'unknown';
  }
}

/**
 * Cheap one-way hash for the recipient JID so anti-ban meta never logs
 * cleartext phone numbers / JIDs.
 */
function hashRecipient(jid: string): string {
  let h = 5381;
  for (let i = 0; i < jid.length; i++) {
    h = ((h << 5) + h) ^ jid.charCodeAt(i);
    h = h >>> 0; // keep uint32
  }
  return h.toString(16);
}
