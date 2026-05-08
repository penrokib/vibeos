import { IsIn, IsString } from "class-validator";

export class UpdateDecisionDto {
  @IsString()
  @IsIn(["pending", "approved", "skipped", "deferred"])
  status!: "pending" | "approved" | "skipped" | "deferred";
}
