import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  CurrentUser,
  JwtAuthGuard,
  Public,
  Roles,
  RolesGuard,
} from "@vibeos/auth";
import type { JwtPayload } from "@vibeos/auth";
import { HeartbeatDto } from "./dto/heartbeat.dto";
import {
  ApproveEnrollmentDto,
  EnrollMachineDto,
  ListMachinesDto,
  RejectEnrollmentDto,
} from "./dto/machine.dto";
import { FleetService } from "./fleet.service";

/**
 * Fleet controller — write surface for the machine registry.
 *
 * Class-C bug-prevention: class-level @UseGuards(JwtAuthGuard, RolesGuard).
 * Per-route overrides:
 *   - POST /fleet/heartbeat   → @Public() because cron jobs can't carry a
 *                                JWT today; guarded server-side by
 *                                FleetService.recordHeartbeat() which 401s
 *                                if `machineId` isn't enrolled. HMAC will
 *                                land in Phase 5d (per spec).
 *   - POST /fleet/enroll      → @Public() — install.sh has no JWT, the
 *                                approval gate IS the security boundary.
 *   - GET  /fleet/enrollment/:id → @Public() — install.sh polls anonymously.
 *                                Returns secrets only ONCE per the service's
 *                                one-time-fetch rule.
 *
 * Everything else is admin-only (Roki's dashboard).
 *
 * Spec: handoffs/agency-v3-inventory/35-fleet-ops.md
 *       handoffs/agency-v3-inventory/38-pc-onboarding-install-system.md
 */
@Controller("fleet")
@UseGuards(JwtAuthGuard, RolesGuard)
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  // ─── Heartbeat ────────────────────────────────────────────────────────
  // Machine identity is asserted by `machineId` in the body, looked up
  // against FleetMachine, and (Phase 5d) verified with the `X-Heartbeat-Sig`
  // header which carries hex-encoded HMAC-SHA256(<machineId>|<lastHeartbeatId>|
  // <receivedAt>, FleetMachine.heartbeatSecret). Strictness is gated by
  // FLEET_HMAC_REQUIRED so we can stage the rollout (existing M3 cron
  // scripts get upgraded over a night) without blackholing the fleet.

  @Post("heartbeat")
  @Public()
  @HttpCode(200)
  async recordHeartbeat(
    @Body() dto: HeartbeatDto,
    @Headers("x-heartbeat-sig") signature?: string,
  ) {
    const machine = await this.fleet.recordHeartbeat(dto, signature);
    return {
      ok: true,
      lastHeartbeatAt: machine.lastHeartbeatAt,
    };
  }

  // ─── Reads (admin) ────────────────────────────────────────────────────

  @Get("machines")
  @Roles("admin")
  listMachines(@Query() filter: ListMachinesDto) {
    return this.fleet.list(filter);
  }

  // Note: declared before the :id route so Nest matches `/health` literally
  // instead of treating "health" as a UUID param (would 400 in any case
  // because of ParseUUIDPipe, but explicit ordering avoids the round-trip).
  @Get("health")
  @Roles("admin")
  health() {
    return this.fleet.health();
  }

  @Get("machines/:id")
  @Roles("admin")
  getMachine(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.fleet.get(id);
  }

  // ─── Enrollment ───────────────────────────────────────────────────────

  /**
   * `POST /fleet/enroll` — initial enrollment. Public because install.sh
   * has no JWT. The drive-by-enroll defense is the WhatsApp approval gate
   * + the explicit admin-only `/approve` endpoint below. Hard Wall #3
   * (NEVER auto-approve) is enforced in the service layer: this endpoint
   * always creates rows with `status: 'pending_approval'`.
   */
  @Post("enroll")
  @Public()
  enroll(@Body() dto: EnrollMachineDto) {
    return this.fleet.enroll(dto);
  }

  /**
   * `GET /fleet/enrollment/:id` — install.sh polls this. Public because the
   * install script has no JWT. The endpoint does NOT leak the existence of
   * other enrollments (id is a UUID, opaque). Once status === 'approved',
   * the FIRST read returns the secrets bundle and the service nulls
   * `tailscaleAuthkey` (Hard Wall #2).
   */
  @Get("enrollment/:id")
  @Public()
  getEnrollment(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.fleet.getEnrollment(id);
  }

  /**
   * `POST /fleet/enrollment/:id/approve` — admin-only. Generates secrets,
   * creates FleetMachine, flips enrollment to `approved`. Roki must
   * explicitly hit this endpoint — there is no auto-approval path.
   */
  @Post("enrollment/:id/approve")
  @Roles("admin")
  approveEnrollment(
    @CurrentUser() user: JwtPayload,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: ApproveEnrollmentDto,
  ) {
    return this.fleet.approveEnrollment(user.email, id, dto);
  }

  @Post("enrollment/:id/reject")
  @Roles("admin")
  rejectEnrollment(
    @CurrentUser() user: JwtPayload,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: RejectEnrollmentDto,
  ) {
    return this.fleet.rejectEnrollment(user.email, id, dto);
  }
}
