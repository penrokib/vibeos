import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * Persona layers — mirrors `status.json.layer` written by the agency-v3
 * skeleton script in `~/Projects/rokibrain/personas/<slug>/status.json`.
 */
export const PERSONA_LAYERS = [
  "c-level",
  "senior-manager",
  "lead",
  "coordinator",
  "specialist",
] as const;
export type PersonaLayer = (typeof PERSONA_LAYERS)[number];

/**
 * Account routing tag — matches MEMORY.md persona-team mapping. Open-ended
 * (new products = new accounts) but we whitelist the current set so a typo
 * in `?account=dewxx` returns 400 instead of an empty list.
 */
export const PERSONA_ACCOUNTS = ["dewx", "dewx2", "ahn", "kidiq"] as const;
export type PersonaAccount = (typeof PERSONA_ACCOUNTS)[number];

/** Hard cap (request-level). Service also enforces this. */
export const MAX_PERSONA_PAGE_SIZE = 500;
export const DEFAULT_PERSONA_PAGE_SIZE = 100;

/**
 * Query DTO for `GET /agency/personas`.
 *
 * Pagination caps at 500 per response — see Hard walls in build prompt.
 * `search` is a case-insensitive substring match on persona slug
 * (e.g. `?search=ahn-` lists every AHN-prefixed persona).
 */
export class ListPersonasDto {
  @IsOptional()
  @IsIn(PERSONA_LAYERS)
  layer?: PersonaLayer;

  @IsOptional()
  @IsIn(PERSONA_ACCOUNTS)
  account?: PersonaAccount;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PERSONA_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  /** Case-insensitive substring match on persona slug. */
  @IsOptional()
  @IsString()
  search?: string;
}

/**
 * Query DTO for `GET /agency/personas/:slug/learnings`.
 * `since` is an ISO-8601 calendar date (YYYY-MM-DD); learnings older than
 * that are filtered out by the service.
 */
export class ListLearningsDto {
  @IsOptional()
  @IsString()
  since?: string;
}

/**
 * Query DTO for `GET /agency/personas/:slug/outbox`.
 */
export class ListOutboxDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PERSONA_PAGE_SIZE)
  limit?: number;
}

/**
 * Lightweight persona summary (list endpoint). Sanitized — no raw metadata
 * spillage. Matches the read-only Phase-3 contract: enough for UI rendering,
 * nothing that would leak credentials or PII.
 */
export interface PersonaSummary {
  slug: string;
  layer: PersonaLayer | "unknown";
  account: string;
  reportsTo: string | null;
  inboxDepth: number;
  outboxUnread: number;
  tabAlive: boolean;
  spawnEligible: boolean;
  lastActiveAt: string | null;
  currentTask: string | null;
  model: string | null;
}

/**
 * Full persona detail (single-slug endpoint). Adds identity.md raw text and
 * the last N outbox entries; still strips private metadata.
 */
export interface PersonaDetail extends PersonaSummary {
  identity: string;
  outboxTail: string[];
  lifetimeTaskCount: number;
  currentIterCount: number;
}
