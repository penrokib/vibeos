import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../../audit/audit.service";

export interface DraftSummary {
  id: string;
  persona: string;
  target: string;
  channel: string;
  body: string;
  created_at: string;
  /** account name — set for drafts routed through SendPipeline. */
  account?: string;
  /** recipient identifier — set for drafts routed through SendPipeline. */
  recipient?: string;
  /** Draft send status (default: 'pending'). */
  status?: 'pending' | 'approved' | 'refused' | 'sent' | 'error' | 'rejected';
}

/**
 * DraftsService — pending outbound drafts (WhatsApp / email / LinkedIn)
 * that personas have queued for Roki's approval.
 *
 * Storage: each draft is one JSON file under `ENROLLMENT_DRAFTS_DIR`
 * (default `/data/personas/ceo/drafts`, set in k8s ConfigMap). Approved
 * drafts move to `<dir>/approved/<id>.json`, rejected to `<dir>/rejected/<id>.json`.
 *
 * Hard wall (per `feedback-orchestrator-dispatches-not-codes.md`): we never
 * auto-send. Only Roki can flip `pending -> approved`. Every action also
 * lands in `audit_events` so the trail survives a server bounce.
 */
@Injectable()
export class DraftsService {
  private readonly logger = new Logger(DraftsService.name);
  private readonly draftsDir: string;
  private readonly approvedDir: string;
  private readonly rejectedDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {
    const fallbackBrain = resolve(process.cwd(), "../../../rokibrain");
    const brainRoot = this.config.get<string>("ROKIBRAIN_ROOT") ?? fallbackBrain;
    this.draftsDir = resolve(
      this.config.get<string>("ENROLLMENT_DRAFTS_DIR") ??
        join(brainRoot, "personas/ceo/drafts"),
    );
    this.approvedDir = join(this.draftsDir, "approved");
    this.rejectedDir = join(this.draftsDir, "rejected");
    for (const d of [this.draftsDir, this.approvedDir, this.rejectedDir]) {
      try {
        if (!existsSync(d)) mkdirSync(d, { recursive: true });
      } catch (err) {
        this.logger.warn(
          `drafts dir ${d} not initializable (${(err as Error).message})`,
        );
      }
    }
  }

  /**
   * List every pending draft. We tolerate malformed entries (skip + log)
   * so one bad file doesn't 500 the dashboard.
   */
  async listPending(): Promise<DraftSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.draftsDir);
    } catch (err) {
      this.logger.warn(`drafts dir unreadable: ${(err as Error).message}`);
      return [];
    }
    const out: DraftSummary[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue;
      const id = name.replace(/\.(json|jsonl)$/, "");
      const path = join(this.draftsDir, name);
      try {
        const raw = await fs.readFile(path, "utf8");
        // .jsonl files: take first non-empty line. .json: parse whole.
        const line = name.endsWith(".jsonl")
          ? raw.split("\n").find((l) => l.trim().length > 0) ?? "{}"
          : raw;
        const parsed = JSON.parse(line) as Partial<DraftSummary> & {
          id?: string;
        };
        out.push({
          id: parsed.id ?? id,
          persona: parsed.persona ?? "unknown",
          target: parsed.target ?? "",
          channel: parsed.channel ?? "unknown",
          body: parsed.body ?? "",
          created_at:
            parsed.created_at ??
            (await fs.stat(path)).mtime.toISOString(),
        });
      } catch (err) {
        this.logger.warn(
          `drafts: skipping malformed ${name}: ${(err as Error).message}`,
        );
      }
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out;
  }

  async approve(id: string, actor: string): Promise<{ id: string; status: "approved" }> {
    const path = await this.findPendingFile(id);
    const dest = join(this.approvedDir, `${id}.json`);
    await fs.rename(path, dest);
    await this.audit.record(actor, "drafts.approve", id, { id });
    return { id, status: "approved" };
  }

  async reject(
    id: string,
    actor: string,
    reason?: string,
  ): Promise<{ id: string; status: "rejected" }> {
    const path = await this.findPendingFile(id);
    const dest = join(this.rejectedDir, `${id}.json`);
    await fs.rename(path, dest);
    await this.audit.record(actor, "drafts.reject", id, {
      id,
      reason: reason ?? null,
    });
    return { id, status: "rejected" };
  }

  /**
   * Get a single draft by id (pending, approved, or rejected dir).
   * Returns the DraftSummary or throws NotFoundException.
   */
  async getOne(id: string): Promise<DraftSummary> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id)) {
      throw new BadRequestException("invalid draft id");
    }
    // Search all dirs: pending, approved, rejected
    const dirs = [this.draftsDir, this.approvedDir, this.rejectedDir];
    for (const dir of dirs) {
      for (const ext of ["json", "jsonl"]) {
        const path = join(dir, `${id}.${ext}`);
        try {
          await fs.access(path);
          const raw = await fs.readFile(path, "utf8");
          const line = ext === "jsonl"
            ? (raw.split("\n").find((l) => l.trim().length > 0) ?? "{}")
            : raw;
          const parsed = JSON.parse(line) as Partial<DraftSummary> & { id?: string };
          const stat = await fs.stat(path);
          return {
            id: parsed.id ?? id,
            persona: parsed.persona ?? "unknown",
            target: parsed.target ?? "",
            channel: parsed.channel ?? "unknown",
            body: parsed.body ?? "",
            created_at: parsed.created_at ?? stat.mtime.toISOString(),
            account: parsed.account,
            recipient: parsed.recipient,
            status: parsed.status ?? "pending",
          };
        } catch {
          /* try next */
        }
      }
    }
    throw new NotFoundException(`draft ${id} not found`);
  }

  /**
   * Mark a draft as refused by anti-ban gate. Moves to rejected dir with
   * refused status. Called by SendPipeline POST /agency/drafts/:id/refuse.
   */
  async refuse(
    id: string,
    actor: string,
    reason?: string,
  ): Promise<{ id: string; status: "refused" }> {
    const path = await this.findPendingOrApprovedFile(id);
    // Write updated draft with refused status into rejected dir
    const dest = join(this.rejectedDir, `${id}.json`);
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(path, "utf8");
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch { /* tolerate */ }
    const updated = { ...existing, id, status: "refused", refused_reason: reason ?? null };
    await fs.writeFile(dest, JSON.stringify(updated, null, 2));
    // Remove from pending/approved dir
    try { await fs.unlink(path); } catch { /* may already be gone */ }
    await this.audit.record(actor, "drafts.refuse", id, { id, reason: reason ?? null });
    return { id, status: "refused" };
  }

  /**
   * Mark a draft as sent. Moves to approved dir with sent status.
   * Called by SendPipeline POST /agency/drafts/:id/sent.
   */
  async markSent(
    id: string,
    actor: string,
    messageId?: string,
  ): Promise<{ id: string; status: "sent"; messageId?: string }> {
    const path = await this.findPendingOrApprovedFile(id);
    const dest = join(this.approvedDir, `${id}.json`);
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(path, "utf8");
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch { /* tolerate */ }
    const updated = {
      ...existing,
      id,
      status: "sent",
      sent_at: new Date().toISOString(),
      message_id: messageId ?? null,
    };
    await fs.writeFile(dest, JSON.stringify(updated, null, 2));
    if (path !== dest) {
      try { await fs.unlink(path); } catch { /* may already be moved */ }
    }
    await this.audit.record(actor, "drafts.sent", id, { id, messageId: messageId ?? null });
    return { id, status: "sent", messageId };
  }

  /**
   * Mark a draft as errored. Keeps in pending dir but records error.
   * Called by SendPipeline POST /agency/drafts/:id/error.
   */
  async markError(
    id: string,
    actor: string,
    reason?: string,
  ): Promise<{ id: string; status: "error" }> {
    // Best-effort: update in-place or write to rejected
    let path: string | null = null;
    try {
      path = await this.findPendingOrApprovedFile(id);
    } catch {
      // Draft may be missing — write a minimal error record to rejected
      path = null;
    }
    const errorDest = join(this.rejectedDir, `${id}.error.json`);
    let existing: Record<string, unknown> = {};
    if (path) {
      try {
        const raw = await fs.readFile(path, "utf8");
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch { /* tolerate */ }
    }
    const updated = {
      ...existing,
      id,
      status: "error",
      error_reason: reason ?? null,
      error_at: new Date().toISOString(),
    };
    await fs.writeFile(errorDest, JSON.stringify(updated, null, 2));
    await this.audit.record(actor, "drafts.error", id, { id, reason: reason ?? null });
    return { id, status: "error" };
  }

  /** Locate the pending or approved file for `id`. 404 if missing in both. */
  private async findPendingOrApprovedFile(id: string): Promise<string> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id)) {
      throw new BadRequestException("invalid draft id");
    }
    for (const dir of [this.draftsDir, this.approvedDir]) {
      for (const ext of ["json", "jsonl"]) {
        const path = join(dir, `${id}.${ext}`);
        try {
          await fs.access(path);
          return path;
        } catch {
          /* try next */
        }
      }
    }
    throw new NotFoundException(`draft ${id} not found in pending or approved`);
  }

  /** Locate the pending file for `id` (json or jsonl). 404 if missing. */
  private async findPendingFile(id: string): Promise<string> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id)) {
      throw new BadRequestException("invalid draft id");
    }
    for (const ext of ["json", "jsonl"]) {
      const path = join(this.draftsDir, `${id}.${ext}`);
      try {
        await fs.access(path);
        return path;
      } catch {
        /* try next */
      }
    }
    throw new NotFoundException(`draft ${id} not found`);
  }
}
