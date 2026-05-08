import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

/**
 * Dispatch DTOs for the Phase-4 write surface.
 *
 * Phase 3 (this scaffold) exposes them as type contracts only — the read-only
 * AgencyController never references them. They live here so the follow-up
 * Phase-4 PR (DispatchModule) can import without rewriting the schema, and so
 * the web client can codegen against them today.
 *
 * Hard wall: nothing in this file is wired to a controller in the AgencyModule.
 * Writes flow through the future DispatchModule with its own audit + rate
 * limiting.
 */

export const DISPATCH_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type DispatchPriority = (typeof DISPATCH_PRIORITIES)[number];

/** A single inbox-bound task aimed at one persona. */
export class DispatchTaskDto {
  /** Target persona slug — must match a directory in `personas/<slug>/`. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  personaSlug!: string;

  /** Short headline (becomes the inbox-entry title). */
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  title!: string;

  /** Full task body (markdown allowed). */
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  body!: string;

  @IsOptional()
  @IsIn(DISPATCH_PRIORITIES)
  priority?: DispatchPriority;

  /** Slug of the persona/lead that should receive escalations. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  escalateTo?: string;

  /** Free-form tags (`["bugfix","p0"]`) — surfaced in the inbox table. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  /** ISO-8601 deadline (validated as a string here; parsed in service). */
  @IsOptional()
  @IsString()
  dueAt?: string;
}

/** Payload for POST /agency/dispatch (Phase 4). One or more tasks. */
export class DispatchBatchDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DispatchTaskDto)
  tasks!: DispatchTaskDto[];

  /** Optional batch label — written to every task's inbox entry. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  batchLabel?: string;

  /**
   * Dry-run: validate + render the would-be inbox entries without writing.
   * Useful for the orchestrator's "preview before send" UX.
   */
  @IsOptional()
  @Type(() => Boolean)
  dryRun?: boolean;

  /** Maximum tasks per batch (rate-limit hint to the service). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/**
 * Result envelope for one dispatched task — what Phase-4 returns to the
 * caller. Persisted to outbox/inbox; surfaced to the agency console.
 */
export interface DispatchResult {
  personaSlug: string;
  ok: boolean;
  inboxEntryId?: string;
  error?: string;
  skippedReason?: "dormant" | "blacklisted" | "missing_directory" | "dry_run";
}
