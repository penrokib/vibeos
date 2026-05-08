import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { SUPPORTED_OS, type SupportedOs } from "./heartbeat.dto";

export const FLEET_ROLES = ["worker", "orchestrator", "testing"] as const;
export type FleetRole = (typeof FLEET_ROLES)[number];

export const FLEET_ACCOUNTS = ["dewx", "dewx2", "ahn", "kidiq"] as const;
export type FleetAccount = (typeof FLEET_ACCOUNTS)[number];

export const ENROLLMENT_STATUSES = [
  "pending_approval",
  "approved",
  "rejected",
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/**
 * `POST /fleet/enroll` body. Called by `bin/install.sh` after the WhatsApp
 * approval gate but before any privileged step. The endpoint is `@Public()`
 * because the script has no JWT — the drive-by-enroll defense is the
 * approval requirement (`POST /fleet/enrollment/:id/approve` is admin-only).
 *
 * The flow:
 *   1. install.sh derives a stable `machineId` (hardware UUID + hostname hash)
 *      and generates an ed25519 keypair locally.
 *   2. POST { machine_id, hostname, os, public_key, requested_role } here.
 *   3. Endpoint creates a FleetEnrollment row in `pending_approval` and
 *      returns `{ enrollment_id, status: 'pending_approval' }`.
 *   4. install.sh polls GET /fleet/enrollment/:id every 10s (with backoff).
 *   5. Roki gets a draft WhatsApp message with the approval link.
 *   6. After admin approval, the GET endpoint returns the secrets bundle
 *      ONCE, then nulls `tailscaleAuthkey` so it can never be replayed.
 */
export class EnrollMachineDto {
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  machineId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  hostname!: string;

  @IsIn(SUPPORTED_OS)
  os!: SupportedOs;

  /** PEM-encoded ed25519 public key the machine generated locally. */
  @IsString()
  @MinLength(40)
  @MaxLength(8_000)
  publicKey!: string;

  /** What role the machine *thinks* it should have. Roki may override. */
  @IsOptional()
  @IsIn(FLEET_ROLES)
  requestedRole?: FleetRole;
}

/**
 * `POST /fleet/enrollment/:id/approve` body — admin-only. Roki sets the
 * concrete role + account assignment + the persona slugs the new machine
 * should run. The service generates the heartbeat HMAC secret and (when
 * wired up) mints a Tailscale auth-key from the Tailscale API.
 *
 * Reject path: pass `{ reject: true, reason }` instead and the row flips
 * to `status: 'rejected'` — no secrets generated, no Tailscale call.
 */
export class ApproveEnrollmentDto {
  /** Final role assignment. Defaults to `requestedRole` if omitted. */
  @IsOptional()
  @IsIn(FLEET_ROLES)
  role?: FleetRole;

  @IsIn(FLEET_ACCOUNTS)
  account!: FleetAccount;

  /** Persona slugs to assign on first agent boot. Capped to keep payload sane. */
  @IsArray()
  @IsString({ each: true })
  personaAssignments!: string[];

  /**
   * SSH public keys to push to ~/.ssh/authorized_keys on the new machine.
   * Empty array is allowed (machine doesn't accept inbound SSH).
   */
  @IsArray()
  @IsString({ each: true })
  sshKeys!: string[];

  /**
   * Optional friendly alias (m1, m3, winpc). If omitted, defaults to
   * the hostname.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  hostAlias?: string;

  /**
   * Optional pre-minted Tailscale auth-key. If absent, the service will
   * mint one via the Tailscale API (Phase 5d) — for now this field lets
   * Roki paste a manually-generated key while the API integration lands.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  tailscaleAuthkey?: string;
}

/**
 * `POST /fleet/enrollment/:id/reject` body — admin-only. Decoupled from the
 * approve path so the schema stays clean per endpoint.
 */
export class RejectEnrollmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** `GET /fleet/machines` query string. */
export class ListMachinesDto {
  @IsOptional()
  @IsIn(FLEET_ROLES)
  role?: FleetRole;

  @IsOptional()
  @IsIn(FLEET_ACCOUNTS)
  account?: FleetAccount;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  take?: number;
}
