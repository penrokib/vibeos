// =============================================================================
// vibeOS — MeshMcpServer (Cycle 16)
// -----------------------------------------------------------------------------
// Exposes the mesh.* tool surface to Claude Code / Claude Desktop via the
// Model Context Protocol. A single MCP server consolidates all per-platform
// WA MCP entries.
//
// Architecture §VIII.1 compliance:
//   - All tool args validated via Zod before routing.
//   - JWT bearer checked per-call — no anonymous access even on loopback.
//   - mesh.send_draft goes through anti-ban gates (same path as drafts-tap-approve).
//   - mesh.tab_send calls assertSafeTmuxKeystroke (cc-modal hardwall).
//   - BFF calls fail closed — returns BFF_NOT_CONFIGURED envelope on missing env.
//
// Hardwalls:
//   - NEVER bypass anti-ban.ts for any send path.
//   - NEVER expose raw child internals to tool callers.
//   - NEVER let BFF errors throw — all BFF paths return an error envelope.
// =============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertSafeTmuxKeystroke } from '../anti-ban';
import type { Supervisor } from '../supervisor';
import type { SearchService } from '../search/search.service';
import type { DigestGenerator } from '../digest/digest-generator';
import type { SearchScope } from '../search/search.types';
import type { WaChild } from '../children/wa/wa-child';
import type { BaseMeshChild } from '../base-child';
import type { SendPipeline } from '../send-pipeline';

// ---------------------------------------------------------------------------
// BFF base URL (injected via env; never hardcoded)
// ---------------------------------------------------------------------------

function bffBase(): string | null {
  return process.env['ROKIBRAIN_BFF_URL'] ?? null;
}

function bffToken(): string | null {
  return process.env['ROKIBRAIN_DEV_JWT'] ?? null;
}

// ---------------------------------------------------------------------------
// BFF envelope — returned when BFF is not configured
// ---------------------------------------------------------------------------

export interface BffNotConfiguredEnvelope {
  error: 'BFF_NOT_CONFIGURED';
  detail: string;
}

export interface BffErrorEnvelope {
  error: 'BFF_ERROR';
  status?: number;
  detail: string;
}

export type BffEnvelope<T> = T | BffNotConfiguredEnvelope | BffErrorEnvelope;

// ---------------------------------------------------------------------------
// MCP JWT auth token (env-only; M12 will replace with Keychain)
// ---------------------------------------------------------------------------

export function getMcpToken(): string | null {
  return process.env['VIBEOS_MCP_TOKEN'] ?? null;
}

export function validateMcpToken(bearer: string | undefined): boolean {
  const expected = getMcpToken();
  if (!expected) return false; // failing closed: no token configured
  if (!bearer) return false;
  return bearer === expected;
}

// ---------------------------------------------------------------------------
// BFF HTTP helpers — all fail closed
// ---------------------------------------------------------------------------

async function bffGet<T>(path: string): Promise<BffEnvelope<T>> {
  const base = bffBase();
  const token = bffToken();
  if (!base || !token) {
    return { error: 'BFF_NOT_CONFIGURED', detail: 'ROKIBRAIN_BFF_URL or ROKIBRAIN_DEV_JWT not set' };
  }
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      return { error: 'BFF_ERROR', status: resp.status, detail: `BFF returned ${resp.status}` };
    }
    return (await resp.json()) as T;
  } catch (err) {
    return { error: 'BFF_ERROR', detail: String(err) };
  }
}

async function bffPost<T>(path: string, body: unknown): Promise<BffEnvelope<T>> {
  const base = bffBase();
  const token = bffToken();
  if (!base || !token) {
    return { error: 'BFF_NOT_CONFIGURED', detail: 'ROKIBRAIN_BFF_URL or ROKIBRAIN_DEV_JWT not set' };
  }
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { error: 'BFF_ERROR', status: resp.status, detail: `BFF returned ${resp.status}` };
    }
    return (await resp.json()) as T;
  } catch (err) {
    return { error: 'BFF_ERROR', detail: String(err) };
  }
}

async function bffPatch<T>(path: string, body: unknown): Promise<BffEnvelope<T>> {
  const base = bffBase();
  const token = bffToken();
  if (!base || !token) {
    return { error: 'BFF_NOT_CONFIGURED', detail: 'ROKIBRAIN_BFF_URL or ROKIBRAIN_DEV_JWT not set' };
  }
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { error: 'BFF_ERROR', status: resp.status, detail: `BFF returned ${resp.status}` };
    }
    return (await resp.json()) as T;
  } catch (err) {
    return { error: 'BFF_ERROR', detail: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Child routing helpers
// ---------------------------------------------------------------------------

/**
 * Find a registered child by account name. Looks for WaChild instances
 * whose `account` property matches the requested account.
 */
function findWaChild(supervisor: Supervisor, account: string): WaChild | null {
  const status = supervisor.status();
  for (const child of status.children) {
    if (child.platform !== 'whatsapp') continue;
    // We need the actual instance — use the test seam
    const registered = supervisor.__getChildForTests(child.id);
    if (!registered?.instance) continue;
    const inst = registered.instance as BaseMeshChild & Partial<{ account: string }>;
    if (inst.account === account) {
      return inst as WaChild;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MeshMcpServer
// ---------------------------------------------------------------------------

export interface MeshMcpServerOptions {
  supervisor: Supervisor;
  searchService: SearchService;
  digestGenerator: DigestGenerator;
  /** Cycle 17: injected SendPipeline for mesh.send_draft real wiring. */
  sendPipeline?: SendPipeline;
}

/**
 * Wraps McpServer from @modelcontextprotocol/sdk, registering all mesh.*
 * tools and enforcing JWT auth + hardwalls on every call.
 */
export class MeshMcpServer {
  readonly mcp: McpServer;

  private readonly supervisor: Supervisor;
  private readonly searchService: SearchService;
  private readonly sendPipeline: SendPipeline | undefined;
  constructor(opts: MeshMcpServerOptions) {
    this.supervisor = opts.supervisor;
    this.searchService = opts.searchService;
    this.sendPipeline = opts.sendPipeline;
    // digestGenerator reserved for cycle 17 — digest signal wiring.
    void opts.digestGenerator;

    this.mcp = new McpServer({
      name: 'vibeos-mesh',
      version: '0.16.0',
    });

    this.registerTools();
  }

  // ---- public ---------------------------------------------------------------

  /** Expose the underlying McpServer.connect() for transport wiring. */
  connect(transport: Parameters<McpServer['connect']>[0]): ReturnType<McpServer['connect']> {
    return this.mcp.connect(transport);
  }

  close(): ReturnType<McpServer['close']> {
    return this.mcp.close();
  }

  // ---- auth -----------------------------------------------------------------

  /** Validate a bearer token from a tool call context. */
  private checkAuth(bearer: string | undefined): void {
    if (!validateMcpToken(bearer)) {
      throw new Error('UNAUTHORIZED: valid VIBEOS_MCP_TOKEN bearer required');
    }
  }

  // ---- tool registration ---------------------------------------------------

  private registerTools(): void {
    const { mcp } = this;

    // ------------------------------------------------------------------
    // mesh.list_accounts — all paired accounts via supervisor
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.list_accounts',
      'List all mesh accounts and their connection status.',
      {},
      async (_args: Record<string, never>, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const status = this.supervisor.status();
        const accounts = status.children.map((c) => ({
          id: c.id,
          platform: c.platform,
          state: c.state,
          restartCount: c.restartCount,
          lastError: c.lastError,
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ accounts }) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.list_chats — find WaChild, call listChats
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.list_chats',
      'List chats for a mesh account.',
      {
        account: z.string().describe('Account name (e.g. wap, was, personal)'),
        limit: z.number().int().min(1).max(200).optional().describe('Max chats to return (default 50)'),
      },
      async (args: { account: string; limit?: number }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const child = findWaChild(this.supervisor, args.account);
        if (!child) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ACCOUNT_NOT_FOUND', account: args.account }) }],
          };
        }
        try {
          const chats = await child.listChats(args.limit ?? 50);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ chats }) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'LIST_CHATS_FAILED', detail: String(err) }) }],
          };
        }
      },
    );

    // ------------------------------------------------------------------
    // mesh.list_messages — find child, call listMessages
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.list_messages',
      'List messages in a chat for a mesh account.',
      {
        account: z.string().describe('Account name'),
        chat_id: z.string().describe('Chat JID or ID'),
        limit: z.number().int().min(1).max(200).optional().describe('Max messages to return (default 50)'),
      },
      async (args: { account: string; chat_id: string; limit?: number }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const child = findWaChild(this.supervisor, args.account);
        if (!child) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ACCOUNT_NOT_FOUND', account: args.account }) }],
          };
        }
        try {
          const messages = await child.listMessages(args.chat_id, args.limit ?? 50);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ messages }) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'LIST_MESSAGES_FAILED', detail: String(err) }) }],
          };
        }
      },
    );

    // ------------------------------------------------------------------
    // mesh.search — calls SearchService
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.search',
      'Search across indexed mesh messages and content.',
      {
        query: z.string().min(1).describe('Search query'),
        scope: z.string().optional().describe('Optional scope filter'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 20)'),
      },
      async (args: { query: string; scope?: string; limit?: number }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const hits = this.searchService.search({
          query: args.query,
          scope: args.scope as SearchScope | undefined,
          limit: args.limit ?? 20,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ hits }) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.draft_message — POSTs to BFF /mesh/drafts (fail-closed stub)
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.draft_message',
      'Create a draft message to be reviewed before sending.',
      {
        account: z.string().describe('Account name'),
        to: z.string().describe('Recipient JID or identifier'),
        text: z.string().min(1).describe('Message text'),
        persona: z.string().optional().describe('Persona to use for this draft'),
      },
      async (args: { account: string; to: string; text: string; persona?: string }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const result = await bffPost<{ draft_id: string; status: string }>('/mesh/drafts', {
          account: args.account,
          to: args.to,
          text: args.text,
          ...(args.persona !== undefined ? { persona: args.persona } : {}),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.list_drafts — GETs from BFF /mesh/drafts
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.list_drafts',
      'List pending message drafts.',
      {
        status: z.enum(['pending', 'approved', 'rejected', 'sent']).optional().describe('Filter by draft status'),
        account: z.string().optional().describe('Filter by account'),
      },
      async (args: { status?: string; account?: string }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const params = new URLSearchParams();
        if (args.status) params.set('status', args.status);
        if (args.account) params.set('account', args.account);
        const qs = params.toString();
        const result = await bffGet<{ drafts: unknown[] }>(`/mesh/drafts${qs ? `?${qs}` : ''}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.update_draft — PATCH /mesh/drafts/:id
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.update_draft',
      'Update the text of a pending draft.',
      {
        draft_id: z.string().describe('Draft ID to update'),
        text: z.string().min(1).describe('New message text'),
      },
      async (args: { draft_id: string; text: string }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const result = await bffPatch<{ draft_id: string; updated: boolean }>(
          `/mesh/drafts/${encodeURIComponent(args.draft_id)}`,
          { text: args.text },
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.send_draft — Cycle 17: real SendPipeline wiring
    // Anti-ban gates → SendPipeline.sendDraft → status update → result.
    // HARD WALL: send ALWAYS goes through SendPipeline. Never call
    // child.send() directly from MCP surface.
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.send_draft',
      'Send a draft via its account child. Goes through anti-ban gates via SendPipeline. Result includes status (sent|refused|error) and reason on refusal.',
      {
        draft_id: z.string().describe('Draft ID to send'),
      },
      async (args: { draft_id: string }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);

        if (!this.sendPipeline) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'SEND_PIPELINE_NOT_CONFIGURED', detail: 'SendPipeline not injected into MeshMcpServer' }),
            }],
          };
        }

        try {
          const result = await this.sendPipeline.sendDraft(args.draft_id);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'SEND_PIPELINE_ERROR', detail: String(err) }) }],
          };
        }
      },
    );

    // ------------------------------------------------------------------
    // mesh.list_decisions — GETs from BFF /mesh/decisions
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.list_decisions',
      'List pending decisions requiring user action.',
      {
        status: z.enum(['pending', 'resolved']).optional().describe('Filter by decision status'),
      },
      async (args: { status?: string }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const qs = args.status ? `?status=${encodeURIComponent(args.status)}` : '';
        const result = await bffGet<{ decisions: unknown[] }>(`/mesh/decisions${qs}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.decide — POST /mesh/decisions/:id/resolve
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.decide',
      'Resolve a pending decision with a choice and optional reason.',
      {
        decision_id: z.string().describe('Decision ID to resolve'),
        choice: z.string().describe('The chosen option/action'),
        reason: z.string().optional().describe('Optional explanation for the choice'),
      },
      async (args: { decision_id: string; choice: string; reason?: string }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const result = await bffPost<{ resolved: boolean }>(
          `/mesh/decisions/${encodeURIComponent(args.decision_id)}/resolve`,
          { choice: args.choice, ...(args.reason !== undefined ? { reason: args.reason } : {}) },
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.list_personas — GETs from BFF /mesh/personas
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.list_personas',
      'List registered personas.',
      {
        active_only: z.boolean().optional().describe('If true, return only active personas'),
        search: z.string().optional().describe('Optional search filter'),
      },
      async (args: { active_only?: boolean; search?: string }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const params = new URLSearchParams();
        if (args.active_only) params.set('active_only', 'true');
        if (args.search) params.set('search', args.search);
        const qs = params.toString();
        const result = await bffGet<{ personas: unknown[] }>(`/mesh/personas${qs ? `?${qs}` : ''}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.persona_outbox — GETs from BFF /mesh/personas/:id/outbox
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.persona_outbox',
      'Get the outbox (sent/queued items) for a persona.',
      {
        persona_id: z.string().describe('Persona ID'),
        limit: z.number().int().min(1).max(200).optional().describe('Max items to return (default 20)'),
      },
      async (args: { persona_id: string; limit?: number }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const qs = args.limit ? `?limit=${args.limit}` : '';
        const result = await bffGet<{ items: unknown[] }>(
          `/mesh/personas/${encodeURIComponent(args.persona_id)}/outbox${qs}`,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.health — daemon + children status
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.health',
      'Get daemon and children health status.',
      {},
      async (_args: Record<string, never>, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const status = this.supervisor.status();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              daemon: {
                uptime: status.uptime,
                emergencyStopped: status.emergencyStopped,
              },
              children: status.children,
            }),
          }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.devices — GETs from BFF /mesh/devices
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.devices',
      'List devices in the user\'s mesh.',
      {},
      async (_args: Record<string, never>, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        const result = await bffGet<{ devices: unknown[] }>('/mesh/devices');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );

    // ------------------------------------------------------------------
    // mesh.tab_send — routes to TmuxChild with cc-modal hardwall
    // ------------------------------------------------------------------
    mcp.tool(
      'mesh.tab_send',
      'Send keystrokes to a tmux pane on a device. CC-modal hardwall enforced.',
      {
        device: z.string().describe('Target device identifier'),
        tab: z.string().describe('Tmux pane/tab identifier'),
        keys: z.union([
          z.string(),
          z.array(z.string()),
        ]).describe('Keys to send (string or array of tmux tokens)'),
      },
      async (args: { device: string; tab: string; keys: string | string[] }, extra: { authInfo?: { token?: string } }) => {
        this.checkAuth(extra?.authInfo?.token);
        // CC-modal hardwall — throws UnsafeKeystrokeError if forbidden keys
        assertSafeTmuxKeystroke(args.keys);
        // Route to BFF for device dispatch (TmuxChild lives on device)
        const result = await bffPost<{ sent: boolean }>(
          '/mesh/tab-send',
          { device: args.device, tab: args.tab, keys: args.keys },
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );
  }
}
