import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import type { JwtPayload } from "@vibeos/auth";
import { TerminalService } from "./terminal.service";

type Role = "bridge" | "client";

interface SocketData {
  owner: string;
  role: Role;
  /** client-only — set of subscribed session names */
  sessions?: Set<string>;
}

/**
 * TerminalGateway — WS broker for terminal mirror.
 *
 * Path: `/ws/terminal`. Auth: JWT in handshake `?token=<jwt>`. Role:
 * `?role=bridge|client` (defaults to `client`). Owner is derived from
 * the JWT claim — single-tenant in v1, multi-tenant trivially later.
 *
 * Message envelopes (see apps/bff/src/terminal/README.md):
 *   { type: "keystroke", session, data }     // client -> bridge
 *   { type: "resize",    session, cols, rows } // client -> bridge
 *   { type: "pane",      session, data }     // bridge -> clients
 *   { type: "subscribe", session }           // client -> server (no relay)
 *   { type: "unsubscribe", session }         // client -> server
 */
@WebSocketGateway({
  path: "/ws/terminal",
  cors: { origin: true, credentials: true },
})
export class TerminalGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(TerminalGateway.name);

  constructor(private readonly terminal: TerminalService) {}

  handleConnection(@ConnectedSocket() socket: Socket): void {
    // socket.io stores handshake query on .handshake.query
    const q = socket.handshake.query ?? {};
    const token = typeof q.token === "string" ? q.token : undefined;
    const roleRaw = typeof q.role === "string" ? q.role : "client";
    const role: Role = roleRaw === "bridge" ? "bridge" : "client";

    let claims: JwtPayload;
    try {
      claims = this.terminal.verifyToken(token);
    } catch (err) {
      this.logger.warn(
        `WS auth rejected role=${role} reason=${(err as Error).message}`,
      );
      socket.emit("error", { code: "unauthorized" });
      socket.disconnect(true);
      return;
    }

    const owner = (claims.email ?? claims.sub).toLowerCase();
    const data = socket.data as SocketData;
    data.owner = owner;
    data.role = role;
    if (role === "client") data.sessions = new Set();

    if (role === "bridge") this.terminal.registerBridge(owner, socket);
    else this.terminal.registerClient(owner, socket);

    socket.emit("hello", { role, owner });
  }

  handleDisconnect(@ConnectedSocket() socket: Socket): void {
    const data = socket.data as Partial<SocketData>;
    if (!data?.owner || !data.role) return;
    if (data.role === "bridge") this.terminal.unregisterBridge(data.owner, socket.id);
    else this.terminal.unregisterClient(data.owner, socket);
  }

  /**
   * Unified message handler. Socket.IO routes by event name; we use a
   * single `message` event to keep the wire envelope server-agnostic
   * (the Swift client speaks raw JSON over a single channel).
   */
  @SubscribeMessage("message")
  onMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody() raw: unknown,
  ): void {
    const data = socket.data as SocketData;
    if (!data?.owner) return; // not authed (shouldn't happen)

    const msg = raw as Record<string, unknown>;
    const type = msg?.type as string | undefined;
    const session = msg?.session as string | undefined;

    if (data.role === "client") {
      switch (type) {
        case "subscribe":
          if (session) data.sessions?.add(session);
          return;
        case "unsubscribe":
          if (session) data.sessions?.delete(session);
          return;
        case "keystroke":
        case "resize":
          if (!session) return;
          this.terminal.forwardKeystrokeToBridge(data.owner, {
            type,
            session,
            ...msg,
          });
          return;
        default:
          this.logger.warn(`client unknown msg type=${type}`);
          return;
      }
    }

    // role === "bridge"
    if (type === "pane" && session && typeof msg.data === "string") {
      this.terminal.broadcastPaneToClients(data.owner, {
        type: "pane",
        session,
        data: msg.data,
      });
    }
  }
}
