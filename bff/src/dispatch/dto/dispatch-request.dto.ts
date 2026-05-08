import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * Allowed priorities. dispatch.sh accepts P0|P1|P2|P3 but the BFF surface
 * only exposes P0–P2 (per spec — P3 is reserved for batch-style cron jobs
 * that don't go through the HTTP API).
 */
export const DISPATCH_PRIORITIES = ["P0", "P1", "P2"] as const;
export type DispatchPriority = (typeof DISPATCH_PRIORITIES)[number];

/**
 * Slug shape shared by `to`, `from`, and `in_reply_to` task-id parsing.
 * Matches the on-disk layout `personas/<slug>/`. Lowercase, dash-separated,
 * 1–80 chars, no spaces, no `..`, no path traversal characters.
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * `from` accepts a persona slug OR one of the orchestrator handles
 * (ceo / cto / roki). The hard-wall "no dispatch TO roki" rule lives in
 * the service layer — this DTO only narrows the lexical shape.
 */
const FROM_REGEX = /^(ceo|cto|roki|[a-z0-9][a-z0-9-]{0,79})$/;

/**
 * POST /dispatch body. Mirrors the dispatch.sh CLI surface but with
 * strict validation so we never shell out untrusted text.
 */
export class DispatchRequestDto {
  /**
   * Persona slug to dispatch TO. Must exist on disk at
   * `~/Projects/rokibrain/personas/<slug>/identity.md` — checked in service.
   */
  @IsString()
  @Matches(SLUG_REGEX, {
    message: "to must be a lowercase persona slug (a-z, 0-9, dash; max 80 chars)",
  })
  to!: string;

  /**
   * Free-form task description. Becomes the body of the inbox.md task block
   * (after sanitization — nested `---` separators are stripped to keep
   * frontmatter parsing intact, see DispatchService.sanitizeTask).
   */
  @IsString()
  @MinLength(3)
  @MaxLength(4096)
  task!: string;

  @IsIn(DISPATCH_PRIORITIES, {
    message: `priority must be one of ${DISPATCH_PRIORITIES.join("|")}`,
  })
  priority!: DispatchPriority;

  /**
   * Sender persona / handle. Either a persona slug or one of `ceo`,
   * `cto`, `roki`. The chain-of-command guard (specialists may not
   * dispatch laterally) lives in DispatchService.assertCanDispatch.
   */
  @IsString()
  @Matches(FROM_REGEX, {
    message: "from must be a persona slug, or one of: ceo, cto, roki",
  })
  from!: string;

  /**
   * Optional structured context — written into the task body as a fenced
   * `json` block. Free shape, but length-capped via JSON.stringify in the
   * service to keep total inbox.md writes bounded.
   */
  @IsOptional()
  @IsObject()
  @Type(() => Object)
  context?: Record<string, unknown>;

  /**
   * Optional task_id of the message being replied to. Matches the
   * dispatch.sh task-id format `YYYY-MM-DDTHH:MM:SS-NNNNN` (or the
   * persona-prefix variant the BFF mints, see DispatchService.mintTaskId).
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{1,120}$/, {
    message: "in_reply_to must be a kebab-style task id (a-z, 0-9, dash, max 120)",
  })
  in_reply_to?: string;
}

/**
 * POST /dispatch/escalate body. A coordinator/specialist that can't dispatch
 * laterally uses this to bubble a problem UP to its parent (lead /
 * senior-manager / c-level).
 */
export class EscalateRequestDto {
  @IsString()
  @Matches(SLUG_REGEX)
  from_persona!: string;

  @IsString()
  @Matches(SLUG_REGEX)
  to_parent!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(4096)
  reason!: string;
}

/**
 * Query DTO for `GET /dispatch/ledger`.
 */
export class LedgerQueryDto {
  /**
   * ISO date (YYYY-MM-DD) — entries strictly older than this are filtered
   * out. Optional; default = no lower bound.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "since must be in YYYY-MM-DD format",
  })
  since?: string;

  @IsOptional()
  @IsString()
  @Matches(SLUG_REGEX)
  persona?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
