// =============================================================================
// vibeOS BFF — ComposeController (Cycle 18)
// -----------------------------------------------------------------------------
// REST endpoints for phone-side compose (voice or typed text).
//
// BFF NEVER calls CC directly — it only routes to the user's Mac daemon via
// MeshGateway WS, where ComposePipeline runs the CC subprocess.
//
// Hard walls:
//   - JwtAuthGuard on every route.
//   - Tenant isolation: every call scoped via TenantContextService.
//   - Voice audio: passed through RAM → Mac WS → cleared. NEVER disk-written.
//   - GET /compose/:requestId returns 404 if the request belongs to another tenant.
// =============================================================================

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  type JwtPayload,
} from "@vibeos/auth";
import { ComposeService } from "./compose.service";
import { ComposeTextDto, ComposeVoiceDto } from "./dto/compose.dto";

@Controller("compose")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin", "persona")
export class ComposeController {
  constructor(private readonly compose: ComposeService) {}

  /**
   * POST /compose/text — compose from typed text.
   * BFF routes a compose-request WS event to user's Mac daemon.
   * Mac daemon calls ComposePipeline (CC subprocess) → posts draft → replies result.
   * Hard wall: BFF NEVER calls CC. Returns requestId for polling.
   */
  @Post("text")
  @HttpCode(202)
  composeText(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ComposeTextDto,
  ): { requestId: string; status: "pending" } {
    const tenantId = user.tenantId ?? user.sub;
    const { requestId } = this.compose.createTextRequest(tenantId, {
      account: dto.account,
      recipient: dto.recipient,
      persona: dto.persona,
      rawText: dto.rawText,
      targetLanguage: dto.targetLanguage,
      mode: dto.mode,
    });
    return { requestId, status: "pending" };
  }

  /**
   * POST /compose/voice — compose from audio (base64-encoded).
   * HARD WALL: audioBase64 is RAM-only. BFF passes it via WS to Mac daemon,
   * which transcribes and calls ComposePipeline. Audio is never stored on disk.
   * Returns requestId for polling.
   */
  @Post("voice")
  @HttpCode(202)
  composeVoice(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ComposeVoiceDto,
  ): { requestId: string; status: "pending" } {
    const tenantId = user.tenantId ?? user.sub;
    const { requestId } = this.compose.createVoiceRequest(tenantId, {
      audioBase64: dto.audioBase64,
      account: dto.account,
      recipient: dto.recipient,
      persona: dto.persona,
      targetLanguage: dto.targetLanguage,
      mode: dto.mode,
    });
    return { requestId, status: "pending" };
  }

  /**
   * GET /compose/:requestId — poll for compose result.
   * Returns 404 if the requestId is not found or belongs to another tenant
   * (tenant isolation hardwall).
   * Returns {status:'pending'} while Mac daemon is still processing.
   * Returns {status:'done', draftId, refinedText, reasoning} when complete.
   * Returns {status:'error', error, detail} on failure.
   */
  @Get(":requestId")
  getResult(
    @CurrentUser() user: JwtPayload,
    @Param("requestId") requestId: string,
  ): {
    status: "pending" | "done" | "error";
    draftId?: string;
    refinedText?: string;
    reasoning?: string;
    error?: string;
    detail?: string;
  } {
    const tenantId = user.tenantId ?? user.sub;
    const req = this.compose.getRequest(requestId, tenantId);

    if (!req) {
      throw new HttpException(
        { status: "error", error: "NOT_FOUND", detail: "Compose request not found or expired" },
        HttpStatus.NOT_FOUND,
      );
    }

    if (req.status === "pending") {
      return { status: "pending" };
    }

    if (req.status === "error") {
      return {
        status: "error",
        error: req.result?.error ?? "UNKNOWN_ERROR",
        detail: req.result?.detail ?? "No detail available",
      };
    }

    return {
      status: "done",
      draftId: req.result?.draftId,
      refinedText: req.result?.refinedText,
      reasoning: req.result?.reasoning,
    };
  }

  /**
   * POST /compose/:requestId/result — Mac daemon calls this when
   * ComposePipeline completes. Tenant isolation: JWT must match original requester.
   * This endpoint is called by the desktop daemon (device-scoped JWT).
   */
  @Post(":requestId/result")
  @HttpCode(200)
  resolveResult(
    @CurrentUser() user: JwtPayload,
    @Param("requestId") requestId: string,
    @Body()
    body: {
      draftId?: string;
      refinedText?: string;
      reasoning?: string;
      error?: string;
      detail?: string;
    },
  ): { ok: boolean } {
    const tenantId = user.tenantId ?? user.sub;
    const resolved = this.compose.resolveRequest(requestId, tenantId, {
      draftId: body.draftId,
      refinedText: body.refinedText,
      reasoning: body.reasoning,
      error: body.error,
      detail: body.detail,
    });

    if (!resolved) {
      throw new HttpException(
        { error: "NOT_FOUND", detail: "Compose request not found, expired, or tenant mismatch" },
        HttpStatus.NOT_FOUND,
      );
    }

    return { ok: true };
  }
}
