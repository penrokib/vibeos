import { ArrayMaxSize, IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class RegisterFeatureDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_]{1,99}$/, {
    message: "slug must be lowercase snake_case, 2-100 chars",
  })
  slug!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(5_000)
  description!: string;

  @IsString()
  @MaxLength(2_000)
  url!: string;

  @IsString()
  @MaxLength(10_000)
  howto!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];
}
