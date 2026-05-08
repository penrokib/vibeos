import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class RegisterAppDto {
  /** URL-safe slug, e.g. "dewx", "anyhelpnow". */
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,49}$/, {
    message: "slug must be lowercase, 2-50 chars, alphanumeric + hyphen",
  })
  slug!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(2_000)
  baseUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  repoPath?: string;
}
