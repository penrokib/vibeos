import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../audit/audit.service";
import {
  VOICE_KERNEL_MAX_WORDS,
  type VoiceUtteranceDto,
} from "./dto/voice-utterance.dto";
import {
  parseUtterance,
  type NoiseAction,
  type ParsedGrammar,
  type ReadbackTier,
} from "./voice-grammar.parser";

export type { ReadbackTier } from "./voice-grammar.parser";

export interface VoicePendingEntry {
  task_id: string;
  utterance: string;
  noise_marker?: string;
  source: string;
  timestamp: number;
  received_at: number;
  audio_url?: string;
  routed_to_persona: string | null;
  readback_tier: ReadbackTier;
  destructive: boolean;
  requires_confirmation: boolean;
  parsed: ParsedGrammar;
  noise_action: NoiseAction;
  parse_error?: string;
  status: "pending" | "confirmed" | "rejected";
  actor: string;
}

export interface VoiceIngestResult {
  task_id: string;
  parsed: ParsedGrammar;
  routed_to_persona: string | null;
  readback_tier: ReadbackTier;
  requires_confirmation: boolean;
  noise_action: NoiseAction;
  error?: string;
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private readonly pendingPath: string;
  private readonly auditPath: string;
  private readonly personasDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {
    // Default to the rokibrain checkout co-located with the BFF (per
    // server-topology memory). Override via env when running locally so
    // dev boxes don't write into the live brain state.
    const fallbackBrain = resolve(process.cwd(), "../../../rokibrain");
    const brainRoot =
      this.config.get<string>("ROKIBRAIN_ROOT") ?? fallbackBrain;
    this.pendingPath =
      this.config.get<string>("VOICE_PENDING_PATH") ??
      resolve(brainRoot, "state/voice-pending.jsonl");
    this.auditPath =
      this.config.get<string>("VOICE_AUDIT_PATH") ??
      resolve(brainRoot, "state/voice-audit.jsonl");
    // Personas dir — env override first (per spec), then rokibrain default.
    this.personasDir =
      this.config.get<string>("PERSONAS_DIR") ??
      process.env.PERSONAS_DIR ??
      resolve(brainRoot, "personas");

    // Ensure the directory exists so the first append doesn't ENOENT.
    // We do NOT pre-create the file — appendFile handles that.
    try {
      const dir = dirname(this.pendingPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const auditDir = dirname(this.auditPath);
      if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true });
    } catch (err) {
      this.logger.warn(
        `voice state dir not initializable (${(err as Error).message}); ` +
          `endpoints will return 500 until ${this.pendingPath} is writable.`,
      );
    }
  }

  /**
   * Receive an utterance, parse the 14-word grammar, classify readback
   * tier, append to pending log + audit ledger.
   *
   * Hard walls:
   *   - 14-word kernel cap → 422 (preserves existing behavior).
   *   - Destructive verbs always set requires_confirmation=true; the
   *     downstream controller flow waits for a `pop` before executing.
   *   - Unknown verbs return intent=unknown + readback=full + error set
   *     instead of crashing — the parser is fail-closed by design.
   */
  async ingest(
    actor: string,
    dto: VoiceUtteranceDto,
  ): Promise<VoiceIngestResult> {
    const utterance = dto.utterance.trim().replace(/\s+/g, " ");
    if (utterance.length === 0) {
      throw new UnprocessableEntityException("utterance empty after trim");
    }
    const wordCount = utterance.split(" ").length;
    if (wordCount > VOICE_KERNEL_MAX_WORDS) {
      throw new UnprocessableEntityException(
        `utterance is ${wordCount} words; voice kernel cap is ${VOICE_KERNEL_MAX_WORDS}`,
      );
    }

    const result = parseUtterance(utterance, {
      personasDir: this.personasDir,
      noiseMarker: dto.noise_marker,
    });

    const task_id = randomUUID();
    const destructive = result.parsed.intent === "destructive";

    const entry: VoicePendingEntry = {
      task_id,
      utterance,
      noise_marker: dto.noise_marker,
      source: dto.source,
      timestamp: dto.timestamp,
      received_at: Date.now(),
      audio_url: dto.audio_url,
      routed_to_persona: result.routed_to_persona,
      readback_tier: result.readback_tier,
      destructive,
      requires_confirmation: result.requires_confirmation,
      parsed: result.parsed,
      noise_action: result.noise_action,
      parse_error: result.error,
      status: "pending",
      actor,
    };

    // Pending ledger — append-only, append-newest-wins on findEntry().
    await this.appendJsonl(this.pendingPath, entry);

    // Voice-specific audit ledger — JSONL co-located with state/, used by
    // the /admin "voice activity" widget and copy-paste post-mortems.
    await this.appendJsonl(this.auditPath, {
      ts: new Date().toISOString(),
      task_id,
      actor,
      source: dto.source,
      utterance,
      noise_marker: dto.noise_marker,
      noise_action: result.noise_action,
      parsed: result.parsed,
      routed_to_persona: result.routed_to_persona,
      readback_tier: result.readback_tier,
      requires_confirmation: result.requires_confirmation,
      parse_error: result.error,
    });

    // Audit DB — queryable in /admin via AuditService. Never throws.
    await this.audit.record(actor, "voice.utterance", task_id, {
      source: dto.source,
      destructive,
      readback_tier: result.readback_tier,
      requires_confirmation: result.requires_confirmation,
      routed_to_persona: result.routed_to_persona,
      intent: result.parsed.intent,
      verb: result.parsed.verb,
      noise_action: result.noise_action,
      ...(result.error ? { parse_error: result.error } : {}),
    });

    return {
      task_id,
      parsed: result.parsed,
      routed_to_persona: result.routed_to_persona,
      readback_tier: result.readback_tier,
      requires_confirmation: result.requires_confirmation,
      noise_action: result.noise_action,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  /**
   * List pending utterances. Filter `status: pending` because the file is
   * append-only — confirmed/rejected entries stay in the ledger for audit.
   */
  async listPending(limit = 100): Promise<VoicePendingEntry[]> {
    const lines = this.readJsonlSafe(this.pendingPath);
    const pending: VoicePendingEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && pending.length < limit; i--) {
      const line = lines[i];
      try {
        const entry = JSON.parse(line) as VoicePendingEntry;
        if (entry.status === "pending") pending.push(entry);
      } catch {
        // Skip malformed lines — one bad line shouldn't break the list.
      }
    }
    return pending;
  }

  /**
   * Confirm a previously-pending utterance. We don't rewrite the file
   * (append-only ledger); we append a `voice.confirm` audit event and a
   * status-update line. The dashboard derives "current status" from the
   * latest line per task_id.
   */
  async confirm(actor: string, taskId: string): Promise<{ ok: true }> {
    const found = await this.findEntry(taskId);
    if (!found) throw new NotFoundException(`voice utterance ${taskId} not found`);
    const updated: VoicePendingEntry = {
      ...found,
      status: "confirmed",
    };
    await this.appendJsonl(this.pendingPath, updated);
    await this.audit.record(actor, "voice.confirm", taskId, {
      routed_to_persona: found.routed_to_persona,
      destructive: found.destructive,
    });
    return { ok: true };
  }

  /**
   * Tail the audit ledger. Returns up to `limit` most-recent rows.
   * Used by /agency dashboard's "voice activity" widget.
   */
  audit_tail(limit = 100): unknown[] {
    const lines = this.readJsonlSafe(this.auditPath);
    const tail = lines.slice(-Math.min(limit, 500));
    const parsed: unknown[] = [];
    for (const line of tail) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
    return parsed;
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  private async appendJsonl(path: string, entry: object): Promise<void> {
    try {
      await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      this.logger.error(
        `voice ledger write failed path=${path}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  private readJsonlSafe(path: string): string[] {
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf8");
      return raw.split("\n").filter((l) => l.length > 0);
    } catch (err) {
      this.logger.warn(`voice ledger read failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async findEntry(taskId: string): Promise<VoicePendingEntry | null> {
    const lines = this.readJsonlSafe(this.pendingPath);
    // Walk backwards — most recent state for that task_id wins.
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as VoicePendingEntry;
        if (entry.task_id === taskId) return entry;
      } catch {
        // skip malformed
      }
    }
    return null;
  }
}
