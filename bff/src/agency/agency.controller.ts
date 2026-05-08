import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  type JwtPayload,
} from "@vibeos/auth";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { AgencyService } from "./agency.service";
import { DraftsService } from "./drafts/drafts.service";
import { FleetStatusService } from "./fleet-status.service";
import {
  ListLearningsDto,
  ListOutboxDto,
  ListPersonasDto,
} from "./dto/persona.dto";

class RejectDraftDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/**
 * Agency controller — read-only HTTP surface over the 1,243 personas living
 * in `~/Projects/rokibrain/personas/<slug>/`.
 *
 * Class-C bug-prevention: class-level `@UseGuards(JwtAuthGuard, RolesGuard)`.
 * Every route is restricted to `admin` or `persona` actors — testers (the
 * bug-filing role) cannot enumerate the agency. `JwtAuthGuard` is also applied
 * globally in main.ts; declaring it here matches the audit/decisions/bugs
 * convention so the file reads correctly in isolation.
 *
 * Hard walls (Phase 3):
 *  - GET only — no writes. Phase-4 DispatchModule owns mutations.
 *  - learnings.md is sensitive (client names, internal observations) → guard
 *    in front, never bypass with @Public().
 *  - Pagination capped server-side (see persona.dto.ts MAX_PERSONA_PAGE_SIZE).
 */
@Controller("agency")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin", "persona")
export class AgencyController {
  constructor(
    private readonly agency: AgencyService,
    private readonly fleetStatus: FleetStatusService,
    private readonly drafts: DraftsService,
  ) {}

  // ─── Aggregator + drafts (Phase A brain-native) ──────────────────────

  @Get("fleet-status")
  fleetStatus_() {
    return this.fleetStatus.get();
  }

  @Get("drafts/pending")
  draftsPending() {
    return this.drafts.listPending();
  }

  @Post("drafts/:id/approve")
  approveDraft(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.drafts.approve(id, user.email);
  }

  @Post("drafts/:id/reject")
  rejectDraft(
    @Param("id") id: string,
    @Body() body: RejectDraftDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.drafts.reject(id, user.email, body.reason);
  }

  // Note: literal routes (`/stats`, `/health`) are declared before `/:slug`
  // so Nest matches them as paths instead of slug params.
  @Get("stats")
  stats() {
    return this.agency.stats();
  }

  @Get("health")
  health() {
    return this.agency.health();
  }

  @Get("personas")
  list(@Query() filter: ListPersonasDto) {
    return this.agency.list(filter);
  }

  @Get("personas/:slug")
  getOne(@Param("slug") slug: string) {
    return this.agency.getOne(slug);
  }

  @Get("personas/:slug/learnings")
  getLearnings(@Param("slug") slug: string, @Query() dto: ListLearningsDto) {
    return this.agency.getLearnings(slug, dto);
  }

  @Get("personas/:slug/outbox")
  getOutbox(@Param("slug") slug: string, @Query() dto: ListOutboxDto) {
    return this.agency.getOutbox(slug, dto);
  }
}
