import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EnrollmentModule } from "../enrollment/enrollment.module";
import { FleetController } from "./fleet.controller";
import { FleetService } from "./fleet.service";

/**
 * FleetModule — machine registry + heartbeats + onboarding-approval flow
 * for app.rokibrain.com. Tracks every box in Roki's compute fleet
 * (M3 orchestrator, M1 worker, BD-PC, future Win-PC, future remote nodes).
 *
 * Wires:
 *   - FleetController exposes POST /fleet/heartbeat, POST /fleet/enroll,
 *     GET /fleet/enrollment/:id (all @Public — guarded server-side),
 *     plus admin-only reads + POST /fleet/enrollment/:id/{approve,reject}.
 *   - FleetService owns the rate-limited heartbeat path, the one-time
 *     secrets fetch, and the WhatsApp draft generator.
 *   - AuditModule supplies AuditService so every approval / rejection /
 *     secrets-fetch lands in `audit_events` (per Dewx audit-trail pattern).
 *
 * NOT wired here (intentionally):
 *   - WhatsApp send: drafts are returned in the enroll response body and
 *     forwarded by the orchestrator (Tab 1) — Hard Wall #4 says we never
 *     auto-send. When the WA-MY MCP bridge gains a server-side hook this
 *     module will inject a NotificationService, not call WA directly.
 *   - Tailscale auth-key minting: Phase 5d. Today the approver pastes a
 *     manually-generated key into ApproveEnrollmentDto.tailscaleAuthkey.
 *
 * Wired into AppModule by the parent agent (per task: do NOT touch
 * app.module.ts in this PR). The registration line is:
 *
 *     import { FleetModule } from "./fleet/fleet.module";
 *     // …in @Module({ imports: [...] })
 *     FleetModule,
 */
@Module({
  // EnrollmentModule re-exports TailscaleService so /fleet/enrollment/:id/approve
  // can mint Tailscale auth-keys via the same code path as the WA approval flow.
  imports: [AuditModule, EnrollmentModule],
  controllers: [FleetController],
  providers: [FleetService],
  exports: [FleetService],
})
export class FleetModule {}
