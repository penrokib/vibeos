import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  access,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  DispatchPriority,
  DispatchRequestDto,
  EscalateRequestDto,
  LedgerQueryDto,
} from "./dto/dispatch-request.dto";

const execFileP = promisify(execFile);

/**
 * Single ledger entry — what we append to `state/dispatches.jsonl` per
 * successful dispatch. Mirrors the shape `dispatch.sh` writes (line 137 of
 * the bash script) so file readers don't need to branch on source.
 */
export interface DispatchLedgerEntry {
  ts: string;
  to: string;
  from: string;
  id: string;
  priority: DispatchPriority | string;
  /** Truncated task description (≤ 200 chars) for ledger searchability. */
  title: string;
}

interface DispatchResult {
  task_id: string;
  persona: string;
  inbox_path: string;
  ledger_entry: DispatchLedgerEntry;
}

/**
 * Roles that may originate a downward dispatch. Coordinators and
 * specialists may NOT — they must escalate upward via /dispatch/escalate.
 *
 * Persona role is read from `personas/<slug>/identity.md` frontmatter
 * (`role: c-level | senior-manager | lead | coordinator | specialist`).
 * Files without that frontmatter (or with a non-matching role) are
 * conservative-rejected from initiating a dispatch.
 */
const DISPATCH_ALLOWED_ROLES = new Set(["c-level", "senior-manager", "lead"]);

/**
 * `from` handles that bypass persona-role checks (they're orchestrators,
 * not personas). Roki uses these to drive the agency from the chat UI.
 */
const ORCHESTRATOR_HANDLES = new Set(["ceo", "cto", "roki"]);

/**
 * Hard wall: nobody — not even ceo/cto — is allowed to dispatch TO `roki`.
 * Roki only ever receives information via summaries, never as a direct task.
 * (Sacred chain-of-command rule, see CLAUDE memory.)
 */
const NEVER_DISPATCH_TO = new Set(["roki"]);

const TITLE_TRUNC = 200;

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);
  private readonly rokibrainRoot: string;
  private readonly personasDir: string;
  private readonly stateDir: string;
  private readonly ledgerPath: string;
  private readonly dispatchScript: string;

  constructor(private readonly config: ConfigService) {
    // ROKIBRAIN_ROOT respects the same env hook dispatch.sh reads (line 22).
    this.rokibrainRoot = resolve(
      this.config.get<string>("ROKIBRAIN_ROOT") ?? join(homedir(), "Projects", "rokibrain"),
    );
    this.personasDir = join(this.rokibrainRoot, "personas");
    this.stateDir = join(this.rokibrainRoot, "state");
    this.ledgerPath = join(this.stateDir, "dispatches.jsonl");
    this.dispatchScript = join(this.rokibrainRoot, "bin", "dispatch.sh");
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Validate, mint task_id, shell out to dispatch.sh with sanitized args,
   * append to ledger. Throws clear HTTP errors on validation failure.
   */
  async dispatch(dto: DispatchRequestDto): Promise<DispatchResult> {
    if (NEVER_DISPATCH_TO.has(dto.to)) {
      throw new ForbiddenException(
        "dispatch to 'roki' is forbidden — Roki receives via summaries only",
      );
    }

    await this.assertPersonaExists(dto.to);
    await this.assertCanDispatch(dto.from);

    const sanitizedTask = this.sanitizeTask(dto.task);
    const taskId = this.mintTaskId(dto.to);
    const taskTitle = this.deriveTitle(sanitizedTask);
    const taskBody = this.composeBody(sanitizedTask, dto.context, dto.in_reply_to, taskId);

    // Shell out via execFile (NEVER exec — we pass args as an array so a
    // task title like `; rm -rf /` is treated as one literal arg, not a
    // shell metasequence). Body is piped via stdin, never interpolated.
    await this.invokeDispatchScript({
      persona: dto.to,
      title: taskTitle,
      from: dto.from,
      priority: dto.priority,
      bodyStdin: taskBody,
    });

    const ledgerEntry: DispatchLedgerEntry = {
      ts: new Date().toISOString(),
      to: dto.to,
      from: dto.from,
      id: taskId,
      priority: dto.priority,
      title: this.truncate(sanitizedTask, TITLE_TRUNC),
    };

    // dispatch.sh already writes its own ledger row (line 137); we add a
    // second row keyed by *our* taskId so HTTP-side tracking stays
    // self-consistent if the bash script's randomization ever drifts.
    await this.appendLedger(ledgerEntry);

    return {
      task_id: taskId,
      persona: dto.to,
      inbox_path: join(this.personasDir, dto.to, "inbox.md"),
      ledger_entry: ledgerEntry,
    };
  }

  /**
   * GET /dispatch/:task_id — scan the ledger for a row with matching id,
   * then peek at the persona's inbox.md to detect "picked up" / "completed"
   * markers. Light-touch: this is a JSONL grep, not a database query.
   */
  async track(taskId: string): Promise<{
    task_id: string;
    found: boolean;
    ledger?: DispatchLedgerEntry;
    inbox_present?: boolean;
    completed?: boolean;
  }> {
    if (!/^[a-zA-Z0-9-]{1,120}$/.test(taskId)) {
      throw new BadRequestException("invalid task_id shape");
    }

    const entries = await this.readLedger({ limit: 5000 });
    const match = entries.find((e) => e.id === taskId);
    if (!match) {
      return { task_id: taskId, found: false };
    }

    const inboxPath = join(this.personasDir, match.to, "inbox.md");
    let inboxText = "";
    try {
      inboxText = await readFile(inboxPath, "utf8");
    } catch {
      // inbox missing — persona was dispatched-to but never read; report.
      return { task_id: taskId, found: true, ledger: match, inbox_present: false };
    }

    const inbox_present = inboxText.includes(`id: ${taskId}`);
    // The convention: completed work is moved from inbox.md → outbox.md
    // (see persona _template). Best-effort completion check.
    let completed = false;
    if (inbox_present) {
      const outboxPath = join(this.personasDir, match.to, "outbox.md");
      try {
        const outboxText = await readFile(outboxPath, "utf8");
        completed = outboxText.includes(taskId);
      } catch {
        completed = false;
      }
    }

    return {
      task_id: taskId,
      found: true,
      ledger: match,
      inbox_present,
      completed,
    };
  }

  /**
   * GET /dispatch/ledger — paged, optionally filtered by persona+date.
   */
  async listLedger(query: LedgerQueryDto): Promise<DispatchLedgerEntry[]> {
    return this.readLedger({
      since: query.since,
      persona: query.persona,
      limit: query.limit ?? 50,
    });
  }

  /**
   * POST /dispatch/escalate — append an escalation block to the parent's
   * inbox. Same shell-out pipeline as dispatch(), but:
   *   - `from` is the child persona (not c-level)
   *   - role check is INVERTED: only coordinator/specialist/lead may escalate
   *   - body carries an "ESCALATION" marker so the parent's intake script
   *     can route it to a high-priority queue.
   */
  async escalate(dto: EscalateRequestDto): Promise<DispatchResult> {
    if (NEVER_DISPATCH_TO.has(dto.to_parent)) {
      throw new ForbiddenException(
        "escalation target 'roki' is forbidden — Roki receives via summaries only",
      );
    }

    await this.assertPersonaExists(dto.from_persona);
    await this.assertPersonaExists(dto.to_parent);

    const sanitizedReason = this.sanitizeTask(dto.reason);
    const taskId = this.mintTaskId(dto.to_parent);
    const taskTitle = `[ESCALATION] ${this.deriveTitle(sanitizedReason)}`;
    const taskBody =
      `**Escalated from:** \`${dto.from_persona}\`\n\n` +
      `**Reason:**\n\n${sanitizedReason}\n`;

    await this.invokeDispatchScript({
      persona: dto.to_parent,
      title: taskTitle,
      from: dto.from_persona,
      // Escalations always go P0 — that's what an escalation IS.
      priority: "P0",
      bodyStdin: taskBody,
    });

    const ledgerEntry: DispatchLedgerEntry = {
      ts: new Date().toISOString(),
      to: dto.to_parent,
      from: dto.from_persona,
      id: taskId,
      priority: "P0",
      title: this.truncate(`[ESCALATION] ${sanitizedReason}`, TITLE_TRUNC),
    };
    await this.appendLedger(ledgerEntry);

    return {
      task_id: taskId,
      persona: dto.to_parent,
      inbox_path: join(this.personasDir, dto.to_parent, "inbox.md"),
      ledger_entry: ledgerEntry,
    };
  }

  // ─── Validation ──────────────────────────────────────────────────────

  /**
   * Reject if `personas/<slug>/identity.md` doesn't exist on disk.
   * NotFoundException so the HTTP layer returns 404, not 500.
   */
  private async assertPersonaExists(slug: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
      throw new BadRequestException(`invalid persona slug: ${slug}`);
    }
    const identityPath = join(this.personasDir, slug, "identity.md");
    try {
      await access(identityPath, fsConstants.R_OK);
    } catch {
      throw new NotFoundException(`persona not found: ${slug}`);
    }
  }

  /**
   * Chain-of-command guard. Reads the FROM persona's identity.md frontmatter
   * `role: ...` field. Only c-level / senior-manager / lead may originate
   * a downward dispatch. Orchestrator handles (ceo/cto/roki) bypass this.
   */
  private async assertCanDispatch(fromHandle: string): Promise<void> {
    if (ORCHESTRATOR_HANDLES.has(fromHandle)) return;

    const identityPath = join(this.personasDir, fromHandle, "identity.md");
    let frontmatter: string;
    try {
      frontmatter = await readFile(identityPath, "utf8");
    } catch {
      throw new NotFoundException(`from-persona not found: ${fromHandle}`);
    }

    const role = this.extractRole(frontmatter);
    if (!role) {
      // Defensive: a persona without a role frontmatter cannot dispatch.
      throw new ForbiddenException(
        `from-persona '${fromHandle}' has no declared role; cannot originate dispatch`,
      );
    }
    if (!DISPATCH_ALLOWED_ROLES.has(role)) {
      throw new ForbiddenException(
        `role '${role}' may not dispatch laterally (only c-level/senior-manager/lead can; ` +
          `coordinators and specialists must use POST /dispatch/escalate)`,
      );
    }
  }

  /** Pull `role: <value>` from a `---`-delimited YAML frontmatter block. */
  private extractRole(markdown: string): string | null {
    // Match a leading `---\n...\n---` frontmatter block, then look for
    // `role:`. Conservative parser — we don't pull in `js-yaml` for one field.
    const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
    const block = fmMatch ? fmMatch[1] : markdown.slice(0, 4000);
    const m = block.match(/^role:\s*['"]?([a-z][a-z0-9-]+)['"]?\s*$/im);
    return m ? m[1].toLowerCase() : null;
  }

  // ─── Sanitization ────────────────────────────────────────────────────

  /**
   * Strip nested `---` separators that would break the frontmatter parser
   * in dispatch.sh / status.json updaters. Also strips ANSI escapes.
   * 4096-char cap is enforced by the DTO; this is defense-in-depth.
   */
  private sanitizeTask(task: string): string {
    const truncated = task.slice(0, 4096);
    return truncated
      .replace(/^---\s*$/gm, "— —") // nested frontmatter separator → safe em-dashes
      .replace(/\x1b\[[0-9;]*m/g, "") // ANSI color codes
      .replace(/\r\n/g, "\n")
      .trimEnd();
  }

  private deriveTitle(task: string): string {
    // Title = first line, max 120 chars. dispatch.sh stuffs this into a
    // `## $TASK_TITLE` heading, so newlines must not leak through.
    const firstLine = task.split("\n", 1)[0]?.trim() || "(untitled task)";
    return this.truncate(firstLine, 120);
  }

  private composeBody(
    task: string,
    context: Record<string, unknown> | undefined,
    inReplyTo: string | undefined,
    taskId: string,
  ): string {
    const lines: string[] = [];
    // Always echo the full task (deriveTitle only takes the first line).
    lines.push(task);
    if (inReplyTo) {
      lines.push("", `**In reply to:** \`${inReplyTo}\``);
    }
    if (context && Object.keys(context).length > 0) {
      let json = "";
      try {
        json = JSON.stringify(context, null, 2).slice(0, 8000);
      } catch {
        json = '"<context failed to serialize>"';
      }
      lines.push("", "**Context:**", "", "```json", json, "```");
    }
    lines.push("", `<!-- bff-task-id: ${taskId} -->`);
    return lines.join("\n");
  }

  private truncate(s: string, n: number): string {
    return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
  }

  // ─── Task ID + ledger ───────────────────────────────────────────────

  /**
   * task_id = `<persona-prefix>-<unix_ts>-<4_hex>`. The persona-prefix
   * (first dashed segment of the slug) keeps grep-by-prefix usable while
   * unix_ts + random suffix guarantee uniqueness within a millisecond.
   */
  private mintTaskId(persona: string): string {
    const prefix = persona.split("-", 1)[0] || "task";
    const unix = Math.floor(Date.now() / 1000);
    const rand = randomBytes(2).toString("hex");
    return `${prefix}-${unix}-${rand}`;
  }

  private async appendLedger(entry: DispatchLedgerEntry): Promise<void> {
    try {
      await mkdir(dirname(this.ledgerPath), { recursive: true });
      await appendFile(this.ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      // Side-rail — log but don't fail the dispatch (per audit-service pattern).
      this.logger.error(
        `ledger write failed id=${entry.id}: ${(err as Error).message}`,
      );
    }
  }

  private async readLedger(opts: {
    since?: string;
    persona?: string;
    limit?: number;
  }): Promise<DispatchLedgerEntry[]> {
    let raw = "";
    try {
      raw = await readFile(this.ledgerPath, "utf8");
    } catch {
      return [];
    }

    const sinceCut = opts.since ? new Date(`${opts.since}T00:00:00Z`).getTime() : 0;
    const out: DispatchLedgerEntry[] = [];
    const lines = raw.split("\n");
    // Walk newest-first by reversing — the file is append-only, so the
    // tail is the most recent. Stop when we hit `limit` matches.
    for (let i = lines.length - 1; i >= 0 && out.length < (opts.limit ?? 50); i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let parsed: DispatchLedgerEntry;
      try {
        parsed = JSON.parse(line) as DispatchLedgerEntry;
      } catch {
        continue;
      }
      if (opts.persona && parsed.to !== opts.persona && parsed.from !== opts.persona) {
        continue;
      }
      if (sinceCut > 0) {
        const t = Date.parse(parsed.ts);
        if (Number.isFinite(t) && t < sinceCut) continue;
      }
      out.push(parsed);
    }
    return out;
  }

  // ─── dispatch.sh shell-out ───────────────────────────────────────────

  /**
   * Invoke `bin/dispatch.sh` with explicitly-quoted args + body via stdin.
   * Uses execFile (no shell) so task titles cannot inject shell metasequences.
   */
  private async invokeDispatchScript(args: {
    persona: string;
    title: string;
    from: string;
    priority: DispatchPriority | "P0" | "P1" | "P2";
    bodyStdin: string;
  }): Promise<void> {
    // Defense in depth: re-validate slugs at the boundary even though the
    // DTO already validated them. assertPersonaExists ran before this.
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(args.persona)) {
      throw new BadRequestException(`invalid persona slug at shell-out: ${args.persona}`);
    }
    if (!/^(ceo|cto|roki|[a-z0-9][a-z0-9-]{0,79})$/.test(args.from)) {
      throw new BadRequestException(`invalid from-handle at shell-out: ${args.from}`);
    }
    if (!/^P[0-3]$/.test(args.priority)) {
      throw new BadRequestException(`invalid priority at shell-out: ${args.priority}`);
    }

    // Verify the script exists + is executable. If a deployer ever
    // mis-symlinks ~/Projects/rokibrain/bin we fail loud, not silent.
    try {
      const st = await stat(this.dispatchScript);
      if (!st.isFile()) {
        throw new InternalServerErrorException("dispatch.sh is not a regular file");
      }
    } catch (err) {
      throw new InternalServerErrorException(
        `dispatch.sh not found at ${this.dispatchScript}: ${(err as Error).message}`,
      );
    }

    // dispatch.sh signature:
    //   dispatch.sh <persona> "<title>" --from <from> --priority <P*> --body-file <path>
    // We use --body-file (not stdin) because Nest's child_process stdin
    // plumbing is fiddly under Express; a temp file is more deterministic.
    const tmpBody = join(this.stateDir, `.dispatch-body-${Date.now()}-${randomBytes(2).toString("hex")}`);
    try {
      await mkdir(this.stateDir, { recursive: true });
      await writeFile(tmpBody, args.bodyStdin, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      throw new InternalServerErrorException(
        `failed to stage body file: ${(err as Error).message}`,
      );
    }

    try {
      await execFileP(
        this.dispatchScript,
        [
          args.persona,
          args.title,
          "--from",
          args.from,
          "--priority",
          args.priority,
          "--body-file",
          tmpBody,
        ],
        {
          // 10s ceiling — a healthy dispatch.sh run is sub-100ms.
          timeout: 10_000,
          // Hard cap on stdout/stderr so a runaway script can't OOM us.
          maxBuffer: 1 * 1024 * 1024,
          env: {
            ...process.env,
            ROKIBRAIN_ROOT: this.rokibrainRoot,
          },
        },
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      this.logger.error(
        `dispatch.sh failed persona=${args.persona} from=${args.from}: ` +
          `${e.message} | stderr=${(e.stderr ?? "").slice(0, 500)}`,
      );
      throw new InternalServerErrorException(
        `dispatch.sh execution failed: ${e.message}`,
      );
    } finally {
      // Best-effort cleanup; ignore failure (the file lives in state/).
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(tmpBody);
      } catch {
        /* swallow */
      }
    }
  }
}
