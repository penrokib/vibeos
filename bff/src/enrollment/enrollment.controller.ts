import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "@vibeos/auth";
import type { JwtPayload } from "@vibeos/auth";
import { EnrollmentService } from "./enrollment.service";

/**
 * EnrollmentController — WhatsApp approval gate for new machine enrollments.
 *
 * Pairs with FleetModule's `/fleet/enroll`. The flow:
 *
 *   1. install.sh on the new machine POSTs `/fleet/enroll` (FleetModule).
 *   2. FleetModule creates `fleet_enrollments` row + asks
 *      EnrollmentService.draftWaApprovalMessage() to pin a copy-paste WA draft.
 *   3. Roki sees the draft under `personas/ceo/drafts/`, sends it manually.
 *   4. Roki replies on WhatsApp; the WA bridge (whatsapp-mcp) parses and POSTs
 *      to `/enrollment/wa-approve/:id` or `/enrollment/wa-reject/:id`.
 *   5. Approve mints the tailscale auth-key (currently stubbed) + persona
 *      assignments. install.sh polls `/fleet/enroll/:id` (FleetModule) until
 *      it sees status=approved, then fetches secrets one-time.
 *
 * Class-C bug-prevention: class-level @UseGuards(JwtAuthGuard, RolesGuard).
 * Approval surface is admin-only — never any role broader than that for a
 * mutation that hands out tailnet credentials.
 */
@Controller("enrollment")
@UseGuards(JwtAuthGuard, RolesGuard)
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  /** GET /enrollment/wa-pending — list enrollments awaiting WA approval. */
  @Get("wa-pending")
  @Roles("admin")
  pending() {
    return this.enrollment.listPending();
  }

  /**
   * POST /enrollment/wa-approve/:enrollment_id — webhook from WA bridge
   * after Roki replies "approve <id>". Mints tailscale auth-key.
   */
  @Post("wa-approve/:enrollment_id")
  @Roles("admin")
  @HttpCode(200)
  approve(
    @CurrentUser() user: JwtPayload,
    @Param("enrollment_id", new ParseUUIDPipe()) enrollmentId: string,
  ) {
    return this.enrollment.approve(user.email ?? user.sub, enrollmentId);
  }

  /**
   * POST /enrollment/wa-reject/:enrollment_id — webhook from WA bridge
   * after Roki replies "reject <id>". Zeroes any pending key.
   */
  @Post("wa-reject/:enrollment_id")
  @Roles("admin")
  @HttpCode(200)
  reject(
    @CurrentUser() user: JwtPayload,
    @Param("enrollment_id", new ParseUUIDPipe()) enrollmentId: string,
  ) {
    return this.enrollment.reject(user.email ?? user.sub, enrollmentId);
  }
}
