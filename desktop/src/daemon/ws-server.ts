// =============================================================================
// rokibrain.app — daemon WS server (M02)
// -----------------------------------------------------------------------------
// Binds ws://127.0.0.1:<ephemeral-port>; chosen port is written to
//   ~/Library/Application Support/rokibrain.app/daemon.port
// (or platform-equivalent userData dir) so the renderer + BFF can discover it.
//
// Auth (M02):
//   - Bearer JWT via `Authorization: Bearer <token>` header on the upgrade
//     request, OR `?token=<…>` query param (renderer prefers header).
//   - For the M01→M02 dev cycle, the supervisor reads JWT secret from
//     `process.env.ROKIBRAIN_DEV_JWT`. M12 will replace this with a Keychain
//     read via Electron `safeStorage`. The compatibility shape is preserved:
//     this module exports `WsAuthStrategy` and the main process injects a
//     concrete instance — so M12 can swap impl without touching ws-server.
//
// Backpressure:
//   - Per-client buffered-amount cap of 1 MB (default). On overflow the
//     OLDEST queued message for that client is dropped; we never block the
//     supervisor on a slow client (design §10 #15: never expose raw stdout
//     to renderer; this is the equivalent rule for backpressure-induced lag).
// =============================================================================

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { WsEnvelope } from './types';

const DEFAULT_BUFFERED_LIMIT_BYTES = 1024 * 1024; // 1 MB
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;

export interface WsAuthDecision {
  ok: boolean;
  /** Reason for refusal — surfaced in the close frame. */
  reason?: string;
  /** Subject id for logging when ok=true. */
  subject?: string;
}

/**
 * Auth strategy contract. M02 ships an env-JWT impl (`EnvJwtAuth`); M12
 * replaces it with a Keychain-backed verifier without touching this file.
 */
export interface WsAuthStrategy {
  /** Verify a token from `Authorization: Bearer …` or `?token=…`. */
  verify(token: string | undefined): Promise<WsAuthDecision> | WsAuthDecision;
}

/**
 * M02 dev JWT — checks against `process.env.ROKIBRAIN_DEV_JWT`. NOT secure
 * for prod; M12 supersedes via Keychain + signed JWT verification.
 */
export class EnvJwtAuth implements WsAuthStrategy {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly varName = 'ROKIBRAIN_DEV_JWT',
  ) {}
  verify(token: string | undefined): WsAuthDecision {
    const expected = this.env[this.varName];
    if (!expected) {
      return { ok: false, reason: 'auth not configured' };
    }
    if (!token) return { ok: false, reason: 'missing bearer' };
    if (token !== expected) return { ok: false, reason: 'invalid bearer' };
    return { ok: true, subject: 'dev-token' };
  }
}

export interface WsServerOptions {
  auth: WsAuthStrategy;
  /** 0 = ephemeral. */
  port?: number;
  /** Bind addr — keep loopback only. */
  host?: string;
  /** Backpressure cap per client; default 1 MB. */
  bufferedAmountLimitBytes?: number;
  /** Optional logger. */
  logger?: { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void };
}

export interface WsClient {
  send: (envelope: WsEnvelope) => void;
  close: (code?: number, reason?: string) => void;
  /** Subject from auth — convenient for routing later. */
  subject: string;
}

export type WsClientHandler = (client: WsClient, envelope: WsEnvelope) => void;

interface ClientState {
  ws: WebSocket;
  subject: string;
  outbox: string[];
  outboxBytes: number;
  alive: boolean;
}

/**
 * Loopback WS server. Lifecycle:
 *   const srv = new DaemonWsServer({ auth: new EnvJwtAuth() });
 *   await srv.listen();
 *   const port = srv.port;            // pass to Supervisor.setWsPort(port)
 *   srv.onMessage((c, env) => …);
 *   …
 *   await srv.close();
 */
export class DaemonWsServer {
  private http: HttpServer;
  private wss: WebSocketServer;
  private readonly clients = new Set<ClientState>();
  private readonly handlers = new Set<WsClientHandler>();
  private pingInterval?: NodeJS.Timeout;
  private readonly bufLimit: number;
  private readonly auth: WsAuthStrategy;
  private readonly host: string;
  private readonly desiredPort: number;
  private readonly log: NonNullable<WsServerOptions['logger']>;

  constructor(opts: WsServerOptions) {
    this.auth = opts.auth;
    this.host = opts.host ?? '127.0.0.1';
    this.desiredPort = opts.port ?? 0;
    this.bufLimit = opts.bufferedAmountLimitBytes ?? DEFAULT_BUFFERED_LIMIT_BYTES;
    this.log = opts.logger ?? {
      info: () => undefined,
      warn: () => undefined,
    };

    this.http = createServer();
    this.wss = new WebSocketServer({ noServer: true });

    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const headerAuth = req.headers['authorization'];
      const bearer =
        typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')
          ? headerAuth.slice('Bearer '.length)
          : (url.searchParams.get('token') ?? undefined);

      Promise.resolve(this.auth.verify(bearer)).then((decision) => {
        if (!decision.ok) {
          this.log.warn('ws auth refused', { reason: decision.reason });
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.attachClient(ws, decision.subject ?? 'anon');
        });
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.desiredPort, this.host, () => {
        this.beginPingLoop();
        this.log.info('ws-server listening', { port: this.port });
        resolve();
      });
    });
  }

  get port(): number {
    const addr = this.http.address() as AddressInfo | string | null;
    if (!addr || typeof addr === 'string') return 0;
    return addr.port;
  }

  onMessage(h: WsClientHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** Broadcast a message to every connected client. */
  broadcast(envelope: WsEnvelope): void {
    for (const c of this.clients) {
      this.enqueue(c, envelope);
    }
  }

  async close(): Promise<void> {
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const c of this.clients) {
      c.ws.close(1001, 'daemon shutting down');
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // ---- internal -----------------------------------------------------------

  private attachClient(ws: WebSocket, subject: string): void {
    const state: ClientState = {
      ws,
      subject,
      outbox: [],
      outboxBytes: 0,
      alive: true,
    };
    this.clients.add(state);
    this.log.info('ws client attached', { subject, total: this.clients.size });

    const wsClient: WsClient = {
      subject,
      send: (env) => this.enqueue(state, env),
      close: (code, reason) => ws.close(code, reason),
    };

    ws.on('pong', () => {
      state.alive = true;
    });
    ws.on('message', (raw) => {
      let parsed: WsEnvelope | null = null;
      try {
        parsed = JSON.parse(raw.toString()) as WsEnvelope;
      } catch {
        this.log.warn('ws: dropping non-JSON frame', { subject });
        return;
      }
      if (!parsed || typeof parsed.channel !== 'string') {
        this.log.warn('ws: malformed envelope', { subject });
        return;
      }
      for (const h of this.handlers) {
        try {
          h(wsClient, parsed);
        } catch (err) {
          this.log.warn('ws handler threw', { err: String(err) });
        }
      }
    });
    ws.on('close', () => {
      this.clients.delete(state);
      this.log.info('ws client detached', { subject, total: this.clients.size });
    });
    ws.on('error', (err) => {
      this.log.warn('ws client error', { subject, err: err.message });
    });
  }

  private enqueue(state: ClientState, env: WsEnvelope): void {
    if (state.ws.readyState !== state.ws.OPEN) return;
    const frame = JSON.stringify(env);
    const bytes = Buffer.byteLength(frame, 'utf8');

    state.outbox.push(frame);
    state.outboxBytes += bytes;

    // Drop oldest until we are under cap. Hard wall: never block supervisor.
    while (state.outboxBytes > this.bufLimit && state.outbox.length > 1) {
      const dropped = state.outbox.shift();
      if (dropped !== undefined) {
        state.outboxBytes -= Buffer.byteLength(dropped, 'utf8');
      }
    }

    // Flush outbox lazily; nodelay
    this.flush(state);
  }

  private flush(state: ClientState): void {
    while (state.outbox.length > 0 && state.ws.readyState === state.ws.OPEN) {
      const frame = state.outbox.shift();
      if (frame === undefined) break;
      state.outboxBytes -= Buffer.byteLength(frame, 'utf8');
      try {
        state.ws.send(frame);
      } catch (err) {
        this.log.warn('ws send failed', { err: String(err) });
        return;
      }
    }
  }

  private beginPingLoop(): void {
    this.pingInterval = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          this.log.warn('ws ping timeout, terminating', { subject: c.subject });
          c.ws.terminate();
          this.clients.delete(c);
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          // ignore — terminated next tick
        }
      }
    }, PING_INTERVAL_MS);
    // unref so the timer never holds the process alive
    this.pingInterval.unref?.();
  }

  /** Test introspection. */
  get clientCountForTests(): number {
    return this.clients.size;
  }
}

export const __WS_DEFAULTS__ = {
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  DEFAULT_BUFFERED_LIMIT_BYTES,
};
