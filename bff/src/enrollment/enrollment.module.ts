import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuditModule } from "../audit/audit.module";
import { EnrollmentController } from "./enrollment.controller";
import { EnrollmentService } from "./enrollment.service";
import { TailscaleService } from "./tailscale.service";

/**
 * EnrollmentModule — WhatsApp approval gate for new machine enrollments.
 *
 * Pairs with FleetModule (Phase 5c). EnrollmentService is exported so
 * FleetModule's `/fleet/enroll` handler can call
 * `draftWaApprovalMessage(enrollmentId)` whenever a new machine appears.
 *
 * Hard wall: NEVER auto-approve. Roki taps WhatsApp or types "approve"
 * via the BFF — there is no automated path. This is the
 * drive-by-enrollment defense per spec
 * `handoffs/agency-v3-inventory/38-pc-onboarding-install-system.md`.
 *
 * TODO Phase 5c (Tailscale integration):
 *   - Wire `approve()` to the real Tailscale tailnet keys API.
 *   - Add SSH key push (currently stored as JSON in fleet_enrollments).
 *
 * TODO (WA bridge):
 *   - When whatsapp-mcp Malaysian bridge supports outbound webhooks, swap
 *     `draftWaApprovalMessage()` from "write a draft markdown" to
 *     "send via bridge." Until then, copy-paste workflow.
 */
@Module({
  imports: [ConfigModule, AuditModule],
  controllers: [EnrollmentController],
  providers: [EnrollmentService, TailscaleService],
  // Export TailscaleService so FleetModule's `approveEnrollment` path can
  // mint keys via the same code, sharing audit + stub-fallback semantics.
  exports: [EnrollmentService, TailscaleService],
})
export class EnrollmentModule {}
