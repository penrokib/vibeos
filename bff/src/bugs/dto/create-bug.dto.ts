import { Type } from "class-transformer";
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";
import { SEVERITIES, type SeverityName } from "./list-bugs.dto";

/**
 * Multipart-form DTO for `POST /bugs`. All fields arrive as strings (form-data),
 * so we don't enforce a richer shape here — just length/type guards.
 * Files (screenshot, video) are picked off the request by FileFieldsInterceptor.
 */
export class CreateBugDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  description!: string;

  @IsOptional()
  @IsIn(SEVERITIES)
  severity?: SeverityName;

  /** App slug — must already be registered via POST /apps. */
  @IsString()
  appSlug!: string;

  /** Optional feature slug within the app. */
  @IsOptional()
  @IsString()
  featureSlug?: string;

  /**
   * Optional explicit feature id. If provided, takes precedence over featureSlug.
   * Useful for callers who already resolved the feature.
   */
  @IsOptional()
  @IsUUID()
  featureId?: string;

  /** Reporter email — falls back to the JWT user's email when omitted. */
  @IsOptional()
  @IsString()
  reporter?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reporterName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  consoleLog?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  networkErrors?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  userAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  viewportSize?: string;

  // class-validator can't see this, but Type() keeps it from being stripped.
  @IsOptional()
  @Type(() => String)
  _unused?: string;
}
