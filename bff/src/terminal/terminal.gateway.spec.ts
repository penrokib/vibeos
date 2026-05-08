import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { TerminalGateway } from "./terminal.gateway";
import { TerminalService } from "./terminal.service";

/**
 * Smoke test for the WS gateway. Mocks Socket.IO sockets — verifies:
 *   1. handshake auth gates connections
 *   2. client `keystroke` routes through to the bridge
 *   3. bridge `pane` broadcasts only to subscribed clients
 *   4. backpressure: oversized pane bursts get dropped
 */
describe("TerminalGateway", () => {
  let gateway: TerminalGateway;
  let service: TerminalService;
  let jwt: JwtService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        TerminalGateway,
        TerminalService,
        {
          provide: JwtService,
          useValue: {
            verify: jest.fn(),
            sign: jest.fn(),
          },
        },
      ],
    }).compile();

    gateway = moduleRef.get(TerminalGateway);
    service = moduleRef.get(TerminalService);
    jwt = moduleRef.get(JwtService);
  });

  function mkSocket(query: Record<string, string>) {
    const data: Record<string, unknown> = {};
    const emitted: Array<{ event: string; payload: unknown; ack?: () => void }> = [];
    return {
      id: `s-${Math.random().toString(36).slice(2, 8)}`,
      handshake: { query },
      data,
      emit: jest.fn((event: string, payload: unknown, ack?: () => void) => {
        emitted.push({ event, payload, ack });
        return true;
      }),
      disconnect: jest.fn(),
      emitted,
    } as never;
  }

  it("rejects connections without a valid token", () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error("bad token");
    });
    const sock: any = mkSocket({ role: "client", token: "nope" });
    gateway.handleConnection(sock);

    expect(sock.disconnect).toHaveBeenCalledWith(true);
  });

  it("routes keystrokes from client → bridge", () => {
    (jwt.verify as jest.Mock).mockReturnValue({
      sub: "roki@dewx.com",
      email: "roki@dewx.com",
      role: "admin",
    });

    const bridge: any = mkSocket({ role: "bridge", token: "ok" });
    gateway.handleConnection(bridge);

    const client: any = mkSocket({ role: "client", token: "ok" });
    gateway.handleConnection(client);

    gateway.onMessage(client, {
      type: "keystroke",
      session: "rokibrain-cto",
      data: "ls\r",
    } as never);

    const bridgeMsg = (bridge.emit as jest.Mock).mock.calls.find(
      (c) => c[0] === "message",
    );
    expect(bridgeMsg).toBeDefined();
    expect(bridgeMsg[1]).toMatchObject({
      type: "keystroke",
      session: "rokibrain-cto",
      data: "ls\r",
    });
  });

  it("broadcasts pane content to subscribed clients only", () => {
    (jwt.verify as jest.Mock).mockReturnValue({
      sub: "roki@dewx.com",
      email: "roki@dewx.com",
      role: "admin",
    });

    const bridge: any = mkSocket({ role: "bridge", token: "ok" });
    gateway.handleConnection(bridge);

    const subscribed: any = mkSocket({ role: "client", token: "ok" });
    gateway.handleConnection(subscribed);
    gateway.onMessage(subscribed, {
      type: "subscribe",
      session: "rokibrain-cto",
    } as never);

    const unsubscribed: any = mkSocket({ role: "client", token: "ok" });
    gateway.handleConnection(unsubscribed);

    gateway.onMessage(bridge, {
      type: "pane",
      session: "rokibrain-cto",
      data: "hello\n",
    } as never);

    const subEmits = (subscribed.emit as jest.Mock).mock.calls.filter(
      (c) => c[0] === "message",
    );
    const unsubEmits = (unsubscribed.emit as jest.Mock).mock.calls.filter(
      (c) => c[0] === "message",
    );
    expect(subEmits.length).toBe(1);
    expect(subEmits[0][1]).toEqual({
      type: "pane",
      session: "rokibrain-cto",
      data: "hello\n",
    });
    expect(unsubEmits.length).toBe(0);
  });

  it("drops pane chunks when a client buffer exceeds 1MB", () => {
    (jwt.verify as jest.Mock).mockReturnValue({
      sub: "roki@dewx.com",
      email: "roki@dewx.com",
      role: "admin",
    });

    const bridge: any = mkSocket({ role: "bridge", token: "ok" });
    gateway.handleConnection(bridge);
    const client: any = mkSocket({ role: "client", token: "ok" });
    gateway.handleConnection(client);
    gateway.onMessage(client, {
      type: "subscribe",
      session: "x",
    } as never);

    // Override emit to NOT call the ack — simulates a slow client whose
    // bytes never get acknowledged, so the buffered counter only grows.
    (client.emit as jest.Mock).mockImplementation(
      (_event: string, _payload: unknown, _ack?: () => void) => true,
    );

    const bigChunk = "a".repeat(600 * 1024); // 600KB
    gateway.onMessage(bridge, {
      type: "pane",
      session: "x",
      data: bigChunk,
    } as never);
    gateway.onMessage(bridge, {
      type: "pane",
      session: "x",
      data: bigChunk,
    } as never);
    gateway.onMessage(bridge, {
      type: "pane",
      session: "x",
      data: bigChunk,
    } as never);

    const messageEmits = (client.emit as jest.Mock).mock.calls.filter(
      (c) => c[0] === "message",
    );
    // First two fit (1.2MB > 1MB so the 2nd is right at the edge — first
    // alone is 600KB; second pushes counter to 1.2MB which is > 1MB, so
    // second SHOULD drop). At least one drop must happen.
    expect(messageEmits.length).toBeLessThan(3);
  });
});
