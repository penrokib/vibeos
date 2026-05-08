import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FleetService } from "../fleet/fleet.service";

interface PersonaStatus {
  slug: string;
  last_active_at: string | null;
  inbox_depth: number;
  iters: number;
  account: string | null;
  current_task: string | null;
}

interface SaarlandSnapshot {
  t_minus_h: number | null;
  reds: string[];
  yellows: string[];
  greens: string[];
}

export interface FleetStatusPayload {
  personas: PersonaStatus[];
  machines: unknown[];
  saarland: SaarlandSnapshot | null;
  generated_at: string;
}

const CACHE_TTL_MS = 10 * 1000;

/**
 * FleetStatusService — composes persona status + fleet machines + Saarland
 * countdown into one shot for the iOS Home / macOS tray dashboards.
 *
 * 10-second in-memory cache: dashboards poll aggressively but the underlying
 * filesystem reads (1,243 status.json files at the high end) are too
 * expensive to redo on every poke.
 */
@Injectable()
export class FleetStatusService {
  private readonly logger = new Logger(FleetStatusService.name);
  private readonly personasDir: string;
  private readonly runbookPath: string | null;

  private cache: { at: number; payload: FleetStatusPayload } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly fleet: FleetService,
  ) {
    this.personasDir = resolve(
      this.config.get<string>("PERSONAS_DIR") ?? "/data/personas",
    );
    const fallbackBrain = resolve(process.cwd(), "../../../rokibrain");
    const brainRoot =
      this.config.get<string>("ROKIBRAIN_ROOT") ?? fallbackBrain;
    const candidate = join(brainRoot, "runbooks/runbook-saarland-launch.md");
    this.runbookPath =
      this.config.get<string>("SAARLAND_RUNBOOK_PATH") ?? candidate;
  }

  async get(): Promise<FleetStatusPayload> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) {
      return this.cache.payload;
    }

    const [personas, machines, saarland] = await Promise.all([
      this.readPersonas(),
      this.readMachines(),
      this.readSaarland(),
    ]);

    const payload: FleetStatusPayload = {
      personas,
      machines,
      saarland,
      generated_at: new Date().toISOString(),
    };
    this.cache = { at: now, payload };
    return payload;
  }

  private async readPersonas(): Promise<PersonaStatus[]> {
    let slugs: string[];
    try {
      slugs = (await fs.readdir(this.personasDir)).filter(
        (s) => !s.startsWith("_") && !s.startsWith("."),
      );
    } catch (err) {
      this.logger.warn(
        `personas dir ${this.personasDir} unreadable: ${(err as Error).message}`,
      );
      return [];
    }

    const out: PersonaStatus[] = [];
    for (const slug of slugs) {
      const path = join(this.personasDir, slug, "status.json");
      try {
        const raw = await fs.readFile(path, "utf8");
        const s = JSON.parse(raw) as Record<string, unknown>;
        out.push({
          slug,
          last_active_at: (s.last_active_at as string | null) ?? null,
          inbox_depth: Number(s.inbox_depth ?? 0),
          iters: Number(s.current_iter_count ?? 0),
          account: (s.account as string | null) ?? null,
          current_task: (s.current_task as string | null) ?? null,
        });
      } catch {
        /* skip silently — agency.service handles per-slug 404s */
      }
    }
    return out;
  }

  private async readMachines(): Promise<unknown[]> {
    try {
      return await this.fleet.list({});
    } catch (err) {
      this.logger.warn(`fleet.list failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Parse §11 of the Saarland runbook for T-X.Xh + reds/yellows/greens.
   * Lenient: returns null on any read/parse failure so a missing runbook
   * doesn't tank the whole dashboard.
   */
  private async readSaarland(): Promise<SaarlandSnapshot | null> {
    if (!this.runbookPath) return null;
    let raw: string;
    try {
      raw = await fs.readFile(this.runbookPath, "utf8");
    } catch {
      return null;
    }
    // Pull the §11 block (heading like `## 11. ...` or `## §11 ...`).
    const sectionRe = /(^|\n)##\s+(?:§?11[.)]?)[^\n]*\n([\s\S]*?)(?=\n##\s|\Z)/;
    const m = sectionRe.exec(raw);
    const block = m ? m[2] : raw;

    const tMinus = /T\s*-\s*([\d.]+)\s*h/i.exec(block);
    const reds = this.collectBullets(block, /reds?/i);
    const yellows = this.collectBullets(block, /yellows?/i);
    const greens = this.collectBullets(block, /greens?/i);

    if (!tMinus && reds.length === 0 && yellows.length === 0 && greens.length === 0) {
      return null;
    }
    return {
      t_minus_h: tMinus ? Number(tMinus[1]) : null,
      reds,
      yellows,
      greens,
    };
  }

  private collectBullets(block: string, label: RegExp): string[] {
    const re = new RegExp(
      `(?:^|\\n)\\s*[-*]?\\s*\\*\\*${label.source}[^*]*\\*\\*\\s*[:\\-]?\\s*([^\\n]*(?:\\n\\s*[-*]\\s+[^\\n]+)*)`,
      "i",
    );
    const m = re.exec(block);
    if (!m) return [];
    return m[1]
      .split(/\n/)
      .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
      .filter((l) => l.length > 0);
  }
}
