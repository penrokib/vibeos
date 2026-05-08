import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { FleetModule } from "../fleet/fleet.module";
import { AgencyController } from "./agency.controller";
import { AgencyService } from "./agency.service";
import { DraftsService } from "./drafts/drafts.service";
import { FleetStatusService } from "./fleet-status.service";

/**
 * AgencyModule — read-only HTTP API over the personas on disk plus
 * dashboard aggregators (fleet-status) and the Roki-approval drafts queue.
 *
 * Phase A (2026-05-07) extensions:
 *   - GET  /agency/fleet-status         — composite for iOS / macOS dashboards
 *   - GET  /agency/drafts/pending       — pending outbound drafts
 *   - POST /agency/drafts/:id/approve   — flip draft -> approved + audit
 *   - POST /agency/drafts/:id/reject    — flip draft -> rejected + audit
 */
@Module({
  imports: [AuditModule, FleetModule],
  controllers: [AgencyController],
  providers: [AgencyService, FleetStatusService, DraftsService],
  exports: [AgencyService],
})
export class AgencyModule {}
