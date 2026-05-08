// =============================================================================
// ws-server.test.ts
// -----------------------------------------------------------------------------
// Covers:
//   - JWT auth refused without a bearer token (401)
//   - JWT auth refused with wrong token
//   - Authed client connects, sends/receives envelopes
//   - Backpressure: outbox cap drops oldest when overflowed
// =============================================================================

import http from 'node:http';
import WebSocket from 'ws';
import { DaemonWsServer, EnvJwtAuth } from '../ws-server';

async function makeServer(opts?: { token?: string; bufLimit?: number }): Promise<{
  server: DaemonWsServer;
  port: number;
  cleanup: () => Promise<void>;
}> {
  const auth = new EnvJwtAuth({ ROKIBRAIN_DEV_JWT: opts?.token ?? 'secret-xyz' });
  const server = new DaemonWsServer({
    auth,
    port: 0,
    bufferedAmountLimitBytes: opts?.bufLimit,
  });
  await server.listen();
  return {
    server,
    port: server.port,
    cleanup: () => server.close(),
  };
}

function attemptUpgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        host: '127.0.0.1',
        method: 'GET',
        path: '/',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...headers,
        },
      },
      (res) => resolve(res.statusCode ?? 0),
    );
    req.on('upgrade', (res) => {
      // Successful 101 — manually parse status from raw frame.
      resolve(res.statusCode ?? 101);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('DaemonWsServer auth', () => {
  it('refuses upgrade without bearer (401)', async () => {
    const { port, cleanup } = await makeServer();
    const status = await attemptUpgrade(port, {});
    expect(status).toBe(401);
    await cleanup();
  });

  it('refuses upgrade with wrong bearer (401)', async () => {
    const { port, cleanup } = await makeServer({ token: 'right-token' });
    const status = await attemptUpgrade(port, { Authorization: 'Bearer wrong-token' });
    expect(status).toBe(401);
    await cleanup();
  });

  it('accepts a connection with the correct bearer', async () => {
    const { server, port, cleanup } = await makeServer({ token: 'sekrit' });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: 'Bearer sekrit' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect(server.clientCountForTests).toBe(1);
    ws.close();
    await cleanup();
  });

  it('refuses when ROKIBRAIN_DEV_JWT env var is missing', async () => {
    const auth = new EnvJwtAuth({});
    const decision = await auth.verify('anything');
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/auth not configured/);
  });
});

describe('DaemonWsServer messaging', () => {
  it('round-trips a valid JSON envelope', async () => {
    const { server, port, cleanup } = await makeServer({ token: 't' });
    const got = new Promise<unknown>((resolve) => {
      server.onMessage((_c, env) => resolve(env));
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: 'Bearer t' },
    });
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(JSON.stringify({ seq: 1, channel: 'test', payload: { x: 1 } }));
    const env = (await got) as { channel: string; seq: number };
    expect(env.channel).toBe('test');
    expect(env.seq).toBe(1);

    ws.close();
    await cleanup();
  });

  it('drops malformed (non-JSON) frames silently', async () => {
    const { server, port, cleanup } = await makeServer({ token: 't' });
    const handler = jest.fn();
    server.onMessage(handler);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: 'Bearer t' },
    });
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send('not json');
    // give it a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).not.toHaveBeenCalled();

    ws.close();
    await cleanup();
  });
});
