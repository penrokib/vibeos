import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  body!: string;

  /** Override author (e.g. `claude:tab-2`) — defaults to JWT user email. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  author?: string;
}
