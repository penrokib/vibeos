import { Type } from "class-transformer";
import {
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/**
 * Per-account quota window the heartbeat reports. Mirrors the structure
 * the brain's `bin/account-quota.sh` emits — `used` is sessions/messages
 * consumed in the rolling window, `limit` is what we believe the cap to be.
 *
 * Shape kept loose (Prisma `Json`) so we can extend without DB migration:
 *   { used: number, limit: number, resetAt?: ISO8601 }
 */
export class AccountQuotaWindowDto {
  @IsInt()
  @Min(0)
  used!: number;

  @IsInt()
  @Min(0)
  limit!: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  resetAt?: string;
}

/** Per-account quota map. All keys optional — a machine may only own one slot. */
export class AccountQuotaDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AccountQuotaWindowDto)
  dewx?: AccountQuotaWindowDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AccountQuotaWindowDto)
  dewx2?: AccountQuotaWindowDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AccountQuotaWindowDto)
  ahn?: AccountQuotaWindowDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AccountQuotaWindowDto)
  kidiq?: AccountQuotaWindowDto;
}

export const SUPPORTED_OS = ["darwin", "linux", "windows-wsl"] as const;
export type SupportedOs = (typeof SUPPORTED_OS)[number];

/**
 * `POST /fleet/heartbeat` body. Cron'd from each machine every ~5 min by
 * `bin/m1-heartbeat.sh` (and siblings on other boxes). `machineId` must
 * match an enrolled machine; otherwise the controller 401s.
 *
 * Class-C bug-prevention notes:
 *   - Every field has an explicit cap to keep log volume bounded.
 *   - `accountQuota` is structurally validated but stored as Prisma Json so
 *     evolution doesn't require a migration.
 *   - Optional `lastHeartbeatAt` is the previous heartbeat timestamp the
 *     machine echoes back — used in the future HMAC handshake to prevent
 *     replay (current stub is JwtAuthGuard, see service comments).
 */
export class HeartbeatDto {
  /** Stable machine identifier (hardware-UUID + hostname hash). */
  @IsString()
  @MaxLength(200)
  machineId!: string;

  @IsString()
  @MaxLength(200)
  hostname!: string;

  /** Friendly alias the orchestrator uses (m1, m3, winpc, hetzner, ...). */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  hostAlias?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  publicIp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tailscaleIp?: string;

  @IsInt()
  @Min(0)
  personaCount!: number;

  @IsInt()
  @Min(0)
  tmuxSessionCount!: number;

  /** Total RAM in GB (e.g. 36, 16, 251). */
  @IsNumber()
  @Min(0)
  ramGb!: number;

  /** 1-minute load average. macOS/Linux compatible. */
  @IsNumber()
  @Min(0)
  cpuLoad!: number;

  @ValidateNested()
  @Type(() => AccountQuotaDto)
  @IsObject()
  accountQuota!: AccountQuotaDto;

  /** Last persona slug the machine actively dispatched. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastActivePersona?: string;

  /** ISO8601 — when the machine last ran a persona task. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  lastActiveAt?: string;

  /**
   * UUID of the previous heartbeat row this machine received an `ok` for.
   * Empty string for the very first heartbeat (no prior row exists yet).
   *
   * Bound into the HMAC payload so a captured signature can't be replayed
   * for a different (machineId, lastHeartbeatId, receivedAt) tuple — the
   * server checks both signature validity AND replay (the heartbeat itself
   * is rate-limited so a captured signature has at most a 60s window of
   * abuse before the next legitimate heartbeat invalidates the previous id).
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastHeartbeatId?: string;

  /**
   * ISO8601 the CLIENT generated when it built this heartbeat. Bound into
   * the HMAC payload so the server can reject signatures whose `receivedAt`
   * drifts more than the allowed clock-skew window — defense against the
   * "captured a signature 6 hours ago, replaying now" attack.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  receivedAt?: string;
}
