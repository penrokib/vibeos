import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Socket } from "socket.io";
import type { JwtPayload } from "@vibeos/auth";

/**
 * TerminalService — registry + router for the WS terminal-mirror gateway.
 *
 * Two connection roles, distinguished by `?role=` on the WS handshake:
 *   - `bridge` — the rokibrain-bridge daemon on M3. Multiplexes 9 cockpit
 *     panes via tmux pipe-pane / send-keys. One bridge per device_owner.
 *   - `client` — iOS / macOS apps. Subscribes to a session_name and
 *     receives pane content; sends keystrokes back.
 *
 * Routing key: `device_owner` (the JWT `sub`/`email`). Single-tenant in v1
 * (only Roki), but the registry is keyed by owner so multi-user just works
 * the day we add more users.
 *
 * Backpressure: each client carries a buffered byte counter. If a pane
 * burst exceeds 1MB of un-flushed data we drop the oldest queued chunks
 * (the live tail is what matters; scrollback comes from another endpoint).
 */
@Injectable()
export class TerminalService {
  private readonly logger = new Logger(TerminalService.name);

  /** owner email -> active bridge socket (one bridge per owner in v1) */
  private readonly bridges = new Map<string, Socket>();

  /** owner email -> set of subscribed client sockets */
  private readonly clients = new Map<string, Set<Socket>>();

  /** socket.id -> per-socket buffered bytes counter (client-only) */
  private readonly clientBufferBytes = new Map<string, number>();

  static readonly CLIENT_BUFFER_LIMIT_BYTES = 1024 * 1024; // 1 MB

  constructor(private readonly jwt: JwtService) {}

  /**
   * Verify a JWT lifted from a WS handshake query.
   * Throws UnauthorizedException — gateways translate to a `disconnect()`.
   */
  verifyToken(token: string | undefined): JwtPayload {
    if (!token) throw new UnauthorizedException("missing token");
    try {
      return this.jwt.verify<JwtPayload>(token);
    } catch (err) {
      throw new UnauthorizedException(
        `invalid token: ${(err as Error).message}`,
      );
    }
  }

  registerBridge(owner: string, socket: Socket): void {
    const existing = this.bridges.get(owner);
    if (existing && existing.id !== socket.id) {
      this.logger.warn(
        `bridge replace for owner=${owner} (old=${existing.id} new=${socket.id})`,
      );
      // Last-write-wins: kick the old bridge so we don't double-route.
      try {
        existing.disconnect(true);
      } catch {
        /* ignore */
      }
    }
    this.bridges.set(owner, socket);
    this.logger.log(`bridge connected owner=${owner} socket=${socket.id}`);
  }

  unregisterBridge(owner: string, socketId: string): void {
    const cur = this.bridges.get(owner);
    if (cur && cur.id === socketId) {
      this.bridges.delete(owner);
      this.logger.log(`bridge disconnected owner=${owner}`);
    }
  }

  registerClient(owner: string, socket: Socket): void {
    let set = this.clients.get(owner);
    if (!set) {
      set = new Set();
      this.clients.set(owner, set);
    }
    set.add(socket);
    this.clientBufferBytes.set(socket.id, 0);
    this.logger.log(`client connected owner=${owner} socket=${socket.id}`);
  }

  unregisterClient(owner: string, socket: Socket): void {
    const set = this.clients.get(owner);
    if (set) {
      set.delete(socket);
      if (set.size === 0) this.clients.delete(owner);
    }
    this.clientBufferBytes.delete(socket.id);
  }

  /**
   * Forward a keystroke from a client to its owner's bridge.
   * Returns true if the bridge was online and accepted the message.
   */
  forwardKeystrokeToBridge(
    owner: string,
    payload: { type: "keystroke" | "resize"; session: string; [k: string]: unknown },
  ): boolean {
    const bridge = this.bridges.get(owner);
    if (!bridge) return false;
    bridge.emit("message", payload);
    return true;
  }

  /**
   * Broadcast bridge-originated pane content to every client of this owner
   * subscribed to the same session. Applies the 1MB per-client backpressure
   * cap by dropping oldest-pending chunks (we just don't emit when buffer
   * is full — Socket.IO's own queue handles ordering).
   */
  broadcastPaneToClients(
    owner: string,
    payload: { type: "pane"; session: string; data: string },
  ): void {
    const set = this.clients.get(owner);
    if (!set || set.size === 0) return;

    const chunkBytes = Buffer.byteLength(payload.data ?? "", "utf8");

    for (const client of set) {
      // Only forward to clients subscribed to this session. The `data` map
      // on socket carries the active subscription set (see gateway).
      const subs = (client.data as { sessions?: Set<string> } | undefined)
        ?.sessions;
      if (!subs || !subs.has(payload.session)) continue;

      const buffered = this.clientBufferBytes.get(client.id) ?? 0;
      if (buffered + chunkBytes > TerminalService.CLIENT_BUFFER_LIMIT_BYTES) {
        // Drop: client is too slow. Reset counter to give it room to recover.
        this.clientBufferBytes.set(client.id, 0);
        this.logger.warn(
          `client buffer full owner=${owner} socket=${client.id} session=${payload.session} — dropping pane chunk`,
        );
        continue;
      }
      this.clientBufferBytes.set(client.id, buffered + chunkBytes);

      // socket.io's internal write callback fires when the chunk has been
      // flushed; decrement the counter then.
      client.emit("message", payload, () => {
        const cur = this.clientBufferBytes.get(client.id) ?? 0;
        this.clientBufferBytes.set(
          client.id,
          Math.max(0, cur - chunkBytes),
        );
      });
    }
  }

  /** Test/debug helpers. */
  bridgeCount(): number {
    return this.bridges.size;
  }
  clientCount(owner?: string): number {
    if (owner) return this.clients.get(owner)?.size ?? 0;
    let total = 0;
    for (const s of this.clients.values()) total += s.size;
    return total;
  }
}
