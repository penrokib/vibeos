import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export const BUG_STATUSES = [
  "OPEN",
  "CLAIMED",
  "IN_PROGRESS",
  "FIXED",
  "VERIFIED",
  "CLOSED",
  "WONT_FIX",
  "DUPLICATE",
] as const;
export type BugStatusName = (typeof BUG_STATUSES)[number];

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type SeverityName = (typeof SEVERITIES)[number];

export class ListBugsDto {
  /** App slug filter (e.g. "dewx", "anyhelpnow"). */
  @IsOptional()
  @IsString()
  app?: string;

  @IsOptional()
  @IsIn(BUG_STATUSES)
  status?: BugStatusName;

  @IsOptional()
  @IsIn(SEVERITIES)
  severity?: SeverityName;

  @IsOptional()
  @IsString()
  claimedBy?: string;

  @IsOptional()
  @IsString()
  reporter?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  take?: number;
}
