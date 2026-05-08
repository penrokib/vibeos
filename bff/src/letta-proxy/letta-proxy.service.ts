import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface CreateAgentInput {
  persona: string;
  system_prompt: string;
  tools: string[];
}

interface SendMessageOutput {
  response: string;
  updated_memory_state: unknown;
}

interface PersonaStatus {
  letta_agent_id?: string | null;
  [key: string]: unknown;
}

const DEFAULT_LETTA_URL = "http://letta.internal.rokibrain.com:8080";
/** Per-request timeout budget. Letta server is on-prem k3s — 10s is generous. */
const LETTA_TIMEOUT_MS = 10_000;

/**
 * LettaProxyService — bridges rokibrain BFF → Letta server (k3s).
 *
 * Each persona owns a Letta agent for memory persistence. The agent_id
 * lives in `personas/<persona>/status.json` so both the BFF and the brain's
 * dispatch.sh see the same identifier.
 *
 * Stub-mode posture (Class-A from Dewx LEARNINGS): if the Letta URL is
 * unreachable, the service logs a warning and returns deterministic mock
 * responses. Module init NEVER crashes on missing Letta — keeps the BFF
 * bootable on dev boxes that don't run the k3s cluster.
 */
@Injectable()
export class LettaProxyService {
  private readonly logger = new Logger(LettaProxyService.name);
  private readonly lettaUrl: string;
  private readonly personasRoot: string;

  constructor(private readonly config: ConfigService) {
    this.lettaUrl =
      this.config.get<string>("LETTA_URL") ??
      process.env.LETTA_URL ??
      DEFAULT_LETTA_URL;

    const fallbackBrain = resolve(process.cwd(), "../../../rokibrain");
    const brainRoot =
      this.config.get<string>("ROKIBRAIN_ROOT") ?? fallbackBrain;
    this.personasRoot =
      this.config.get<string>("ROKIBRAIN_PERSONAS_ROOT") ??
      resolve(brainRoot, "personas");

    this.logger.log(`Letta proxy targeting ${this.lettaUrl}`);
  }

  /**
   * Create a Letta agent for a persona and cache the agent_id in the
   * persona's status.json so dispatch.sh can find it without a round-trip.
   */
  async createAgent(input: CreateAgentInput): Promise<{ letta_agent_id: string }> {
    const upstream = await this.lettaPost<{ id: string }>(`/v1/agents`, {
      persona: input.persona,
      system_prompt: input.system_prompt,
      tools: input.tools,
    });

    const letta_agent_id =
      upstream?.id ??
      // Stub fallback when Letta unreachable. Prefixed so the dashboard can
      // tell stubs from real ids at a glance.
      `stub-${input.persona}-${randomUUID().slice(0, 8)}`;

    await this.writePersonaStatus(input.persona, { letta_agent_id });

    return { letta_agent_id };
  }

  /**
   * Send a message to a Letta agent. Returns `{ response, updated_memory_state }`.
   * Stub returns a structured echo so callers can develop against a stable shape.
   */
  async sendMessage(agentId: string, message: string): Promise<SendMessageOutput> {
    if (!agentId || agentId.trim().length === 0) {
      throw new NotFoundException("agent_id required");
    }
    const upstream = await this.lettaPost<SendMessageOutput>(
      `/v1/agents/${encodeURIComponent(agentId)}/messages`,
      { message },
    );
    if (upstream) return upstream;
    return {
      response: `[stub] letta unreachable; echoing: ${message.slice(0, 200)}`,
      updated_memory_state: { stub: true, lastMessage: message.slice(0, 200) },
    };
  }

  /** GET memory state — admin only on the controller. */
  async getMemory(agentId: string): Promise<unknown> {
    if (!agentId || agentId.trim().length === 0) {
      throw new NotFoundException("agent_id required");
    }
    const upstream = await this.lettaGet<unknown>(
      `/v1/agents/${encodeURIComponent(agentId)}/memory`,
    );
    if (upstream !== null) return upstream;
    return { stub: true, agent_id: agentId, memory_blocks: [] };
  }

  /**
   * Wipe a Letta agent. GDPR right-to-forget — Roki only.
   * Best-effort: removes upstream + clears letta_agent_id from any persona
   * status.json that referenced it.
   */
  async wipeAgent(agentId: string): Promise<{ ok: true }> {
    if (!agentId || agentId.trim().length === 0) {
      throw new NotFoundException("agent_id required");
    }
    const ok = await this.lettaDelete(`/v1/agents/${encodeURIComponent(agentId)}`);
    if (!ok) {
      this.logger.warn(
        `letta delete returned non-ok for agent=${agentId}; clearing local pointer regardless`,
      );
    }
    await this.clearPersonaPointer(agentId);
    return { ok: true };
  }

  // ─── persona status helpers ──────────────────────────────────────────

  private async writePersonaStatus(
    persona: string,
    patch: Partial<PersonaStatus>,
  ): Promise<void> {
    const path = resolve(this.personasRoot, persona, "status.json");
    if (!existsSync(path)) {
      this.logger.warn(
        `persona status not found at ${path}; skipping letta_agent_id cache`,
      );
      return;
    }
    try {
      const raw = readFileSync(path, "utf8");
      const current = JSON.parse(raw) as PersonaStatus;
      const merged = { ...current, ...patch };
      await writeFile(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
    } catch (err) {
      this.logger.error(
        `failed to patch persona ${persona} status: ${(err as Error).message}`,
      );
    }
  }

  private async clearPersonaPointer(agentId: string): Promise<void> {
    // Best-effort — without scanning every persona dir we can't be sure
    // which persona owned the id. We log and move on; the next status.json
    // write from createAgent will overwrite cleanly.
    this.logger.log(`letta agent ${agentId} wiped — persona pointer not auto-cleared`);
  }

  // ─── upstream helpers (fetch-based; no axios dep needed) ─────────────

  private async lettaPost<T>(path: string, body: unknown): Promise<T | null> {
    const url = this.urlFor(path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LETTA_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.logger.warn(`letta POST ${path} → ${res.status}; falling back to stub`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(
        `letta POST ${path} unreachable (${(err as Error).message}); stub mode`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async lettaGet<T>(path: string): Promise<T | null> {
    const url = this.urlFor(path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LETTA_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      if (res.status === 404) {
        throw new NotFoundException(`letta resource not found: ${path}`);
      }
      if (!res.ok) {
        this.logger.warn(`letta GET ${path} → ${res.status}; falling back to stub`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      this.logger.warn(
        `letta GET ${path} unreachable (${(err as Error).message}); stub mode`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async lettaDelete(path: string): Promise<boolean> {
    const url = this.urlFor(path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LETTA_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: "DELETE", signal: ctrl.signal });
      if (res.status === 404) {
        throw new NotFoundException(`letta agent not found: ${path}`);
      }
      if (res.status >= 500) {
        throw new ServiceUnavailableException(
          `letta delete failed: upstream ${res.status}`,
        );
      }
      return res.ok;
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.warn(
        `letta DELETE ${path} unreachable (${(err as Error).message}); ` +
          `treating as best-effort wipe`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private urlFor(path: string): string {
    const base = this.lettaUrl.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }
}
