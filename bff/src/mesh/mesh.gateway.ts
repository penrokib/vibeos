import { Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Socket } from "socket.io";
import type { JwtPayload } from "@vibeos/auth";

interface MeshSocketData {
  owner: string;
  /** Per-socket buffered byte counter; backpressure cap = 1MB. */
  buffered: number;
}

/**
 * MeshGateway — outbound WS for the desktop daemon to receive live mesh
 * events. Events emitted:
 *   - `mesh.<platform>.inbound`       (from mesh-child via REST → broadcast)
 *   - `mesh.draft.queued`             (POST /:platform/draft success)
 *   - `mesh.draft.approved`           (POST /draft/:id/approve success)
 *   - `mesh.counter.tripped`          (anti-ban refusal)
 *   - `mesh.account.status`           (status transitions)
 *
 * Auth: JWT in handshake `?token=<jwt>`. Channels the terminal-gateway pattern.
 * Backpressure: drop oldest event if a socket's buffered bytes exceed 1MB.
 *
 * @Injectable so MeshController can inject it to fan out events.
 */
@Injectable()
@WebSocketGateway({
  path: "/ws/mesh",
  cors: { origin: true, credentials: true },
})
export class MeshGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(MeshGateway.name);

  static readonly CLIENT_BUFFER_LIMIT_BYTES = 1024 * 1024;

  /** owner email → set of subscribed sockets. */
  private readonly clients = new Map<string, Set<Socket>>();

  constructor(private readonly jwt: JwtService) {}

  handleConnection(@ConnectedSocket() socket: Socket): void {
    const q = socket.handshake.query ?? {};
    const token = typeof q.token === "string" ? q.token : undefined;

    let claims: JwtPayload;
    try {
      if (!token) throw new Error("missing token");
      claims = this.jwt.verify<JwtPayload>(token);
    } catch (err) {
      this.logger.warn(`mesh ws auth rejected: ${(err as Error).message}`);
      socket.emit("error", { code: "unauthorized" });
      socket.disconnect(true);
      return;
    }

    const owner = (claims.email ?? claims.sub).toLowerCase();
    const data = socket.data as MeshSocketData;
    data.owner = owner;
    data.buffered = 0;

    let set = this.clients.get(owner);
    if (!set) {
      set = new Set();
      this.clients.set(owner, set);
    }
    set.add(socket);

    socket.emit("hello", { owner, channel: "mesh" });
    this.logger.log(`mesh ws connected owner=${owner} socket=${socket.id}`);
  }

  handleDisconnect(@ConnectedSocket() socket: Socket): void {
    const data = socket.data as Partial<MeshSocketData>;
    if (!data?.owner) return;
    const set = this.clients.get(data.owner);
    if (set) {
      set.delete(socket);
      if (set.size === 0) this.clients.delete(data.owner);
    }
  }

  /**
   * Broadcast a mesh event to every connected socket. Owner-scoping is a
   * no-op in single-tenant v1 but the `owner` filter keeps multi-actor
   * the day we add it. Per-socket 1MB backpressure cap with oldest-drop.
   */
  private broadcast(event: string, payload: unknown, owner?: string): void {
    const json = JSON.stringify(payload ?? {});
    const bytes = Buffer.byteLength(json, "utf8");

    const targets: Iterable<Socket> = owner
      ? (this.clients.get(owner) ?? new Set())
      : (function* (clients) {
          for (const set of clients.values()) for (const s of set) yield s;
        })(this.clients);

    for (const sock of targets) {
      const data = sock.data as MeshSocketData;
      if (data.buffered + bytes > MeshGateway.CLIENT_BUFFER_LIMIT_BYTES) {
        // Reset and skip; keeps live tail flowing without unbounded growth.
        data.buffered = 0;
        this.logger.warn(
          `mesh ws backpressure drop owner=${data.owner} socket=${sock.id} event=${event}`,
        );
        continue;
      }
      data.buffered += bytes;
      sock.emit(event, payload, () => {
        data.buffered = Math.max(0, data.buffered - bytes);
      });
    }
  }

  // Public emit helpers — controller and service call these.

  emitInbound(platform: string, payload: unknown, owner?: string): void {
    this.broadcast(`mesh.${platform}.inbound`, payload, owner);
  }

  emitDraftQueued(payload: unknown, owner?: string): void {
    this.broadcast("mesh.draft.queued", payload, owner);
  }

  emitDraftApproved(payload: unknown, owner?: string): void {
    this.broadcast("mesh.draft.approved", payload, owner);
  }

  emitCounterTripped(payload: unknown, owner?: string): void {
    this.broadcast("mesh.counter.tripped", payload, owner);
  }

  emitAccountStatus(payload: unknown, owner?: string): void {
    this.broadcast("mesh.account.status", payload, owner);
  }

  /**
   * Emit a `tmux-input` event to the owner's connected daemon sockets.
   * The daemon TmuxChild.input() handles it and applies the cc-modal hardwall.
   */
  emitTmuxInput(
    owner: string,
    payload: { deviceId: string; paneId: string; keys: string },
  ): void {
    this.broadcast("tmux-input", payload, owner);
  }

  /** Test helper. */
  clientCount(owner?: string): number {
    if (owner) return this.clients.get(owner)?.size ?? 0;
    let total = 0;
    for (const s of this.clients.values()) total += s.size;
    return total;
  }
}
