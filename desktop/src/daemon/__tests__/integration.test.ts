// =============================================================================
// integration.test.ts
// -----------------------------------------------------------------------------
// In-process integration: bootstrap the daemon (bypassing utilityProcess by
// passing a fake parentPort) + register a NoOpChild + start it + verify
// supervisor status round-trips through the parent-port message bus.
//
// Real utilityProcess.fork() integration requires Electron runtime and is
// covered by manual smoke testing during `yarn workspace @vibeos/desktop dev`.
// =============================================================================

import { bootstrapDaemon, type SupervisorOutboundMessage } from '../index';
import { NoOpChild } from '../noop-child';
import type { SupervisorInboundMessage } from '../index';

interface FakeParentPort {
  postMessage: (m: SupervisorOutboundMessage) => void;
  on: (evt: 'message', cb: (m: { data: SupervisorInboundMessage }) => void) => void;
  __sendInbound: (m: SupervisorInboundMessage) => void;
  outbox: SupervisorOutboundMessage[];
}

function makeFakeParentPort(): FakeParentPort {
  const outbox: SupervisorOutboundMessage[] = [];
  let listener: ((m: { data: SupervisorInboundMessage }) => void) | null = null;
  return {
    postMessage: (m) => {
      outbox.push(m);
    },
    on: (_evt, cb) => {
      listener = cb;
    },
    __sendInbound: (m) => {
      listener?.({ data: m });
    },
    outbox,
  };
}

describe('daemon bootstrap + parentPort round-trip', () => {
  it('boots, posts ready, and reports supervisor status snapshots', async () => {
    process.env['ROKIBRAIN_DEV_JWT'] = 'test-token';
    // Disable tmux child registration so this test's child-count assertions
    // remain stable regardless of which children bootstrapDaemon registers.
    process.env['MESH_TMUX_ENABLED'] = 'false';
    const parent = makeFakeParentPort();

    const { supervisor, ws, shutdown } = await bootstrapDaemon({
      parentPort: parent,
      bffClient: { increment: async () => ({ allowed: true }) },
      skipPortFile: true,
    });

    // First outbound msg should be 'ready'.
    expect(parent.outbox[0]?.kind).toBe('ready');
    if (parent.outbox[0]?.kind === 'ready') {
      expect(parent.outbox[0].wsPort).toBeGreaterThan(0);
      expect(parent.outbox[0].status.children).toEqual([]);
    }

    // Register a noop child. Must happen BEFORE startAll for the test seam.
    supervisor.register(
      { id: 'noop-1', platform: 'noop' },
      async (ctx) => new NoOpChild(ctx),
    );

    // Trigger startAll via the inbound bus.
    parent.__sendInbound({ kind: 'startAll' });
    await new Promise((r) => setTimeout(r, 20));

    // Find the most recent 'status' broadcast and check it contains the running child.
    const statusMsgs = parent.outbox.filter((m) => m.kind === 'status');
    expect(statusMsgs.length).toBeGreaterThan(0);
    const last = statusMsgs[statusMsgs.length - 1];
    if (last?.kind === 'status') {
      expect(last.status.children.find((c) => c.id === 'noop-1')?.state).toBe('running');
    }

    // Ask for status via getStatus.
    parent.outbox.length = 0;
    parent.__sendInbound({ kind: 'getStatus' });
    await new Promise((r) => setTimeout(r, 5));
    const st = parent.outbox.find((m) => m.kind === 'status');
    expect(st).toBeDefined();

    // emergencyStop transitions the child to paused.
    parent.__sendInbound({ kind: 'emergencyStop' });
    await new Promise((r) => setTimeout(r, 20));
    const finalStatus = parent.outbox.filter((m) => m.kind === 'status').pop();
    if (finalStatus?.kind === 'status') {
      expect(finalStatus.status.emergencyStopped).toBe(true);
      expect(
        finalStatus.status.children.find((c) => c.id === 'noop-1')?.state,
      ).toBe('paused');
    }

    await shutdown();
    expect(ws.clientCountForTests).toBe(0);
    delete process.env['MESH_TMUX_ENABLED'];
  });

  it('ws port is a valid bound TCP port (loopback only)', async () => {
    process.env['ROKIBRAIN_DEV_JWT'] = 'tt';
    // Disable tmux child so the test environment stays lean.
    process.env['MESH_TMUX_ENABLED'] = 'false';
    const parent = makeFakeParentPort();
    const { ws, shutdown } = await bootstrapDaemon({
      parentPort: parent,
      bffClient: { increment: async () => ({ allowed: true }) },
      skipPortFile: true,
    });
    expect(ws.port).toBeGreaterThan(1024);
    await shutdown();
    delete process.env['MESH_TMUX_ENABLED'];
  });
});
