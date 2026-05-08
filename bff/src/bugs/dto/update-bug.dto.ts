import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { BUG_STATUSES, SEVERITIES, type BugStatusName, type SeverityName } from "./list-bugs.dto";

export class UpdateBugDto {
  @IsOptional()
  @IsIn(BUG_STATUSES)
  status?: BugStatusName;

  @IsOptional()
  @IsIn(SEVERITIES)
  severity?: SeverityName;

  /** Claude tab id (or any worker id) claiming the bug. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  claimedBy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  fixCommitSha?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fixBranch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  verifiedBy?: string;
}
