import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

/**
 * `POST /install/meshcentral-agent/token` body — admin only.
 *
 * `group` is the MeshCentral device-group slug. Allowed characters limited to
 * letters/digits/dash/underscore so the value is safe to embed in a URL path
 * AND in a shell heredoc inside the install script (no quoting surprises).
 */
export class MintAgentTokenDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: "group must match /^[a-zA-Z0-9_-]+$/ (no spaces, no shell metas)",
  })
  group!: string;
}

/**
 * `POST /install/meshcentral-agent/token/verify` body — public (called by the
 * install script with the one-time token). The endpoint authenticates the
 * caller AS the token-bearer; no JWT is needed.
 */
export class VerifyAgentTokenDto {
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  token!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  group!: string;

  @IsOptional()
  @IsString()
  @IsIn(["mac", "linux", "windows", "wsl"])
  os?: "mac" | "linux" | "windows" | "wsl";

  @IsOptional()
  @IsString()
  @MaxLength(20)
  arch?: string;
}
