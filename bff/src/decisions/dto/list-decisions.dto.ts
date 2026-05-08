import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

export const DECISION_STATUSES = ["pending", "approved", "skipped", "deferred"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export class ListDecisionsDto {
  @IsOptional()
  @IsIn(DECISION_STATUSES)
  status?: DecisionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  take?: number;
}
