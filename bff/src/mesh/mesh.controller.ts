import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "@vibeos/auth";
import { CreateAccountDto } from "./dto/create-account.dto";
import {
  ApproveDraftDto,
  CreateDraftDto,
  RejectDraftDto,
} from "./dto/create-draft.dto";
import {
  ContactsQueryDto,
  CountersQueryDto,
  InboxQueryDto,
  ProfileQueryDto,
} from "./dto/inbox-query.dto";
import { KeystrokeDto } from "./dto/keystroke.dto";
import { MESH_PLATFORMS, type MeshPlatform } from "./dto/platform.dto";
import { MeshGateway } from "./mesh.gateway";
import { KeystrokeService } from "./keystroke.service";
import { MeshService } from "./mesh.service";

function assertPlatform(p: string): MeshPlatform {
  if (!(MESH_PLATFORMS as readonly string[]).includes(p)) {
    throw new BadRequestException(`unknown platform: ${p}`);
  }
  return p as MeshPlatform;
}

/**
 * Mesh REST surface — see design §2 + dispatch §16.
 *
 * Class-C bug-prevention: class-level @UseGuards(JwtAuthGuard). Every
 * route is authed; opt out individually with @Public() if ever needed.
 */
@Controller("mesh")
@UseGuards(JwtAuthGuard)
export class MeshController {
  constructor(
    private readonly mesh: MeshService,
    private readonly gateway: MeshGateway,
    private readonly keystroke: KeystrokeService,
  ) {}

  @Get("health")
  health() {
    return this.mesh.health();
  }

  @Get("drafts/pending")
  pendingDrafts() {
    return this.mesh.listPendingDrafts();
  }

  @Get("counters")
  counters(@Query() q: CountersQueryDto) {
    return this.mesh.getCounters(q);
  }

  @Post("accounts")
  createAccount(
    @CurrentUser("email") email: string,
    @Body() dto: CreateAccountDto,
  ) {
    return this.mesh.createAccount(dto, email);
  }

  @Post("draft/:id/approve")
  async approve(
    @CurrentUser("sub") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApproveDraftDto,
  ) {
    const updated = await this.mesh.approveDraft(id, dto, userId);
    this.gateway.emitDraftApproved(updated);
    return updated;
  }

  @Post("draft/:id/reject")
  async reject(
    @CurrentUser("sub") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RejectDraftDto,
  ) {
    return this.mesh.rejectDraft(id, dto, userId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Keystroke send — iOS → BFF → daemon (via WS) → TmuxChild.input()
  // cc-modal hardwall enforced server-side in the daemon (never bypassed).
  // Tenant isolation: deviceId must belong to the JWT's ownerEmail.
  // ─────────────────────────────────────────────────────────────────

  @Post("devices/:deviceId/panes/:paneId/keystroke")
  async keystrokeToPane(
    @CurrentUser("email") email: string,
    @Param("deviceId") deviceId: string,
    @Param("paneId") paneId: string,
    @Body() dto: KeystrokeDto,
  ) {
    return this.keystroke.sendKeystroke(email, deviceId, paneId, dto.keys);
  }

  // Per-platform endpoints — `:platform` last so the static routes above
  // don't get shadowed by a "platform" matching `health` / `accounts`.

  @Get(":platform/inbox")
  inbox(@Param("platform") platform: string, @Query() q: InboxQueryDto) {
    return this.mesh.listInbox(assertPlatform(platform), q);
  }

  @Get(":platform/profile")
  profile(@Param("platform") platform: string, @Query() q: ProfileQueryDto) {
    return this.mesh.getProfile(assertPlatform(platform), q);
  }

  @Get(":platform/contacts")
  contacts(@Param("platform") platform: string, @Query() q: ContactsQueryDto) {
    return this.mesh.listContacts(assertPlatform(platform), q);
  }

  @Post(":platform/draft")
  async createDraft(
    @Param("platform") platform: string,
    @Body() dto: CreateDraftDto,
  ) {
    const draft = await this.mesh.createDraft(assertPlatform(platform), dto);
    this.gateway.emitDraftQueued(draft);
    return draft;
  }
}
