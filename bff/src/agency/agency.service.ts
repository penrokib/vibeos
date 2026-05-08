import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DEFAULT_PERSONA_PAGE_SIZE,
  MAX_PERSONA_PAGE_SIZE,
  PERSONA_LAYERS,
  type ListLearningsDto,
  type ListOutboxDto,
  type ListPersonasDto,
  type PersonaDetail,
  type PersonaLayer,
  type PersonaSummary,
} from "./dto/persona.dto";

/**
 * Raw status.json shape on disk. Source of truth for layer/account/inbox_depth
 * — everything else (identity.md, outbox.md) is derived.
 *
 * `metadata` is intentionally `unknown` because we never expose it raw —
 * it can carry arbitrary keys like `metadata.passwords` or `metadata.token`
 * (PII / credential risk; see Hard walls in build prompt).
 */
interface PersonaStatusFile {
  persona_name?: string;
  layer?: string;
  reports_to?: string | null;
  account?: string;
  current_task?: string | null;
  last_active_at?: string | null;
  inbox_depth?: number;
  outbox_unread?: number;
  tab_session?: string | null;
  tab_alive?: boolean;
  current_iter_count?: number;
  lifetime_task_count?: number;
  letta_agent_id?: string | null;
  model?: string | null;
  spawn_eligible?: boolean;
  metadata?: unknown;
}

/**
 * AgencyService — read-only window into the 1,243 personas living on disk
 * under `~/Projects/rokibrain/personas/<slug>/`.
 *
 * Source of truth: each persona's own `status.json` (layer, account, depth,
 * etc.). Derived files (`identity.md`, `outbox.md`, `learnings.md`) are
 * fetched lazily on the per-slug endpoints.
 *
 * Hard walls (mirrored from Phase-3 prompt):
 *  - READ ONLY — no mutations live here. Writes flow through DispatchModule.
 *  - `metadata.*` is NEVER returned (PII / credentials risk).
 *  - Pagination caps at MAX_PERSONA_PAGE_SIZE (500).
 *  - Persona dirs starting with `_` (e.g. `_template`, `_index`) are hidden
 *    from listings — they're scaffolding, not real personas.
 */
@Injectable()
export class AgencyService {
  private readonly logger = new Logger(AgencyService.name);
  private readonly personasDir: string;

  constructor(private readonly config: ConfigService) {
    this.personasDir = resolve(
      this.config.get<string>("PERSONAS_DIR") ??
        process.env.PERSONAS_DIR ??
        "/Users/rokibulhasan/Projects/rokibrain/personas",
    );
  }

  // ─── Public read API ──────────────────────────────────────────────────

  async list(filter: ListPersonasDto = {}): Promise<{
    items: PersonaSummary[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const slugs = await this.listPersonaSlugs();

    // Read every status.json once. ~1,243 small JSON reads ≈ <500ms on a
    // warm SSD. If this becomes a hot path we cache by mtime.
    const all: PersonaSummary[] = [];
    for (const slug of slugs) {
      const status = await this.safeReadStatus(slug);
      if (!status) continue;
      all.push(this.toSummary(slug, status));
    }

    const filtered = this.applyFilters(all, filter);

    const limit = clamp(
      filter.limit ?? DEFAULT_PERSONA_PAGE_SIZE,
      1,
      MAX_PERSONA_PAGE_SIZE,
    );
    const offset = Math.max(filter.offset ?? 0, 0);
    const items = filtered.slice(offset, offset + limit);

    return { items, total: filtered.length, limit, offset };
  }

  async getOne(slug: string): Promise<PersonaDetail> {
    this.assertSafeSlug(slug);
    const status = await this.safeReadStatus(slug);
    if (!status) throw new NotFoundException(`persona ${slug} not found`);

    const [identity, outboxTail] = await Promise.all([
      this.safeReadFile(slug, "identity.md"),
      this.readOutboxTail(slug, 5),
    ]);

    const summary = this.toSummary(slug, status);
    return {
      ...summary,
      identity: identity ?? "",
      outboxTail,
      lifetimeTaskCount: status.lifetime_task_count ?? 0,
      currentIterCount: status.current_iter_count ?? 0,
    };
  }

  async getLearnings(slug: string, dto: ListLearningsDto): Promise<string> {
    this.assertSafeSlug(slug);
    const exists = await this.safeReadStatus(slug);
    if (!exists) throw new NotFoundException(`persona ${slug} not found`);

    const raw = (await this.safeReadFile(slug, "learnings.md")) ?? "";
    if (!dto.since) return raw;

    return filterLearningsSince(raw, dto.since);
  }

  async getOutbox(slug: string, dto: ListOutboxDto): Promise<string[]> {
    this.assertSafeSlug(slug);
    const exists = await this.safeReadStatus(slug);
    if (!exists) throw new NotFoundException(`persona ${slug} not found`);

    const limit = clamp(dto.limit ?? 10, 1, MAX_PERSONA_PAGE_SIZE);
    return this.readOutboxTail(slug, limit);
  }

  /**
   * Aggregate counts for the dashboard tile.
   * Non-cached — recomputed on every call so freshly-spawned personas show
   * up without a TTL wait. Acceptable at 1,243 rows; revisit at 100k.
   */
  async stats(): Promise<{
    total: number;
    byLayer: Record<string, number>;
    byAccount: Record<string, number>;
    activeInbox: number;
    activeOutbox: number;
    aliveTabs: number;
  }> {
    const slugs = await this.listPersonaSlugs();
    const byLayer: Record<string, number> = Object.fromEntries(
      PERSONA_LAYERS.map((l) => [l, 0]),
    );
    byLayer["unknown"] = 0;
    const byAccount: Record<string, number> = {};

    let activeInbox = 0;
    let activeOutbox = 0;
    let aliveTabs = 0;
    let total = 0;

    for (const slug of slugs) {
      const status = await this.safeReadStatus(slug);
      if (!status) continue;
      total++;

      const layer = (PERSONA_LAYERS as readonly string[]).includes(status.layer ?? "")
        ? (status.layer as PersonaLayer)
        : "unknown";
      byLayer[layer] = (byLayer[layer] ?? 0) + 1;

      const account = status.account ?? "unknown";
      byAccount[account] = (byAccount[account] ?? 0) + 1;

      if ((status.inbox_depth ?? 0) > 0) activeInbox++;
      if ((status.outbox_unread ?? 0) > 0) activeOutbox++;
      if (status.tab_alive === true) aliveTabs++;
    }

    return { total, byLayer, byAccount, activeInbox, activeOutbox, aliveTabs };
  }

  /**
   * Health view — active vs dormant. "Active" = tab_alive OR inbox_depth>0
   * OR outbox_unread>0. Everything else is dormant. Cheap to compute.
   */
  async health(): Promise<{ active: number; dormant: number; total: number }> {
    const slugs = await this.listPersonaSlugs();
    let active = 0;
    let total = 0;
    for (const slug of slugs) {
      const status = await this.safeReadStatus(slug);
      if (!status) continue;
      total++;
      if (
        status.tab_alive === true ||
        (status.inbox_depth ?? 0) > 0 ||
        (status.outbox_unread ?? 0) > 0
      ) {
        active++;
      }
    }
    return { active, dormant: total - active, total };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async listPersonaSlugs(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.personasDir);
    } catch (err) {
      this.logger.error(
        `failed to read personas dir ${this.personasDir}: ${(err as Error).message}`,
      );
      return [];
    }
    // Hide scaffolding dirs (`_template`, `_index`) and hidden files.
    return entries.filter((e) => !e.startsWith("_") && !e.startsWith(".")).sort();
  }

  private async safeReadStatus(slug: string): Promise<PersonaStatusFile | null> {
    const path = join(this.personasDir, slug, "status.json");
    try {
      const raw = await fs.readFile(path, "utf8");
      const parsed = JSON.parse(raw) as PersonaStatusFile;
      // Defensive sanitize: drop the `metadata` blob before it ever leaves
      // this method (Hard wall: never expose private metadata fields like
      // metadata.passwords).
      delete parsed.metadata;
      return parsed;
    } catch (err) {
      // Missing / unreadable / malformed — skip silently in list flows.
      // (The single-slug endpoint converts a null return into 404.)
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        this.logger.warn(
          `status.json unreadable for ${slug}: ${(err as Error).message}`,
        );
      }
      return null;
    }
  }

  private async safeReadFile(slug: string, file: string): Promise<string | null> {
    const path = join(this.personasDir, slug, file);
    try {
      return await fs.readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  private async readOutboxTail(slug: string, limit: number): Promise<string[]> {
    const raw = (await this.safeReadFile(slug, "outbox.md")) ?? "";
    // Outbox entries are markdown blocks separated by `---` fences (see the
    // template in `personas/_template/outbox.md`). Split, trim, take last N.
    const blocks = raw
      .split(/\n---\n/g)
      .map((b) => b.trim())
      .filter((b) => b.length > 0 && !b.startsWith("# "));
    return blocks.slice(-limit);
  }

  private toSummary(slug: string, s: PersonaStatusFile): PersonaSummary {
    const layer = (PERSONA_LAYERS as readonly string[]).includes(s.layer ?? "")
      ? (s.layer as PersonaLayer)
      : "unknown";
    return {
      slug,
      layer,
      account: s.account ?? "unknown",
      reportsTo: s.reports_to ?? null,
      inboxDepth: s.inbox_depth ?? 0,
      outboxUnread: s.outbox_unread ?? 0,
      tabAlive: s.tab_alive === true,
      spawnEligible: s.spawn_eligible !== false,
      lastActiveAt: s.last_active_at ?? null,
      currentTask: s.current_task ?? null,
      model: s.model ?? null,
    };
  }

  private applyFilters(
    rows: PersonaSummary[],
    filter: ListPersonasDto,
  ): PersonaSummary[] {
    let out = rows;
    if (filter.layer) out = out.filter((r) => r.layer === filter.layer);
    if (filter.account) out = out.filter((r) => r.account === filter.account);
    if (filter.search) {
      const needle = filter.search.toLowerCase();
      out = out.filter((r) => r.slug.toLowerCase().includes(needle));
    }
    return out;
  }

  /**
   * Reject anything that isn't a plain persona slug. The personas dir is
   * read-only here, but we still defend against `..`/`/` to keep the
   * fs.readFile calls strictly inside `personasDir/<slug>/`.
   */
  private assertSafeSlug(slug: string): void {
    if (!/^[a-z0-9][a-z0-9._-]{0,200}$/i.test(slug)) {
      throw new NotFoundException(`persona ${slug} not found`);
    }
    if (slug.startsWith("_") || slug.includes("..") || slug.includes("/")) {
      throw new NotFoundException(`persona ${slug} not found`);
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

/**
 * Filter `learnings.md` entries down to those at or after `sinceISO` (a
 * YYYY-MM-DD calendar date). The file format is loose markdown — we look
 * for `### YYYY-MM-DD …` section headers and keep entries whose date
 * matches the cutoff.
 *
 * Anything outside a dated section (e.g. the Format scaffold) is preserved
 * verbatim so the response still reads as well-formed markdown.
 */
export function filterLearningsSince(raw: string, sinceISO: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceISO)) return raw;

  const lines = raw.split("\n");
  const out: string[] = [];
  let inDatedSection = false;
  let keepCurrent = true;

  for (const line of lines) {
    const m = /^###\s+(\d{4}-\d{2}-\d{2})/.exec(line);
    if (m) {
      inDatedSection = true;
      keepCurrent = m[1] >= sinceISO;
      if (keepCurrent) out.push(line);
      continue;
    }
    // New top-level section ends the dated-section run.
    if (line.startsWith("## ") && !line.startsWith("## ###")) {
      inDatedSection = false;
      keepCurrent = true;
    }
    if (!inDatedSection || keepCurrent) {
      out.push(line);
    }
  }
  return out.join("\n");
}
