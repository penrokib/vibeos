import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "@vibeos/auth";
import type { JwtPayload } from "@vibeos/auth";
import { VoiceUtteranceDto } from "./dto/voice-utterance.dto";
import { VoiceService } from "./voice.service";

/**
 * Voice gateway — receives utterances from iOS / Mac companion / Apple Watch,
 * classifies routing tier, queues for persona dispatch.
 *
 * Class-C bug-prevention: class-level @UseGuards(JwtAuthGuard, RolesGuard).
 * Every route requires admin or persona role — voice is privileged input.
 *
 * Spec: handoffs/agency-v3-inventory/37-voice-arch-ios.md (referenced),
 *       protocols/voice-grammar.md (14-word kernel + 3-tier read-back).
 */
@Controller("voice")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin", "persona")
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /**
   * POST /voice/utterance — ingest one utterance.
   *
   * Returns `{ task_id, routed_to_persona, readback_tier }`. The caller
   * (iOS / Mac companion) uses readback_tier to decide whether to play a
   * chime, speak a short confirmation, or do a full read-back-then-confirm.
   */
  @Post("utterance")
  @HttpCode(202)
  ingest(@CurrentUser() user: JwtPayload, @Body() dto: VoiceUtteranceDto) {
    return this.voice.ingest(user.email ?? user.sub, dto);
  }

  /** GET /voice/pending — list pending utterances awaiting review. */
  @Get("pending")
  pending(@Query("limit") limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    return this.voice.listPending(
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    );
  }

  /** POST /voice/utterance/:id/confirm — Roki confirms ambiguous routing. */
  @Post("utterance/:id/confirm")
  @HttpCode(200)
  confirm(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.voice.confirm(user.email ?? user.sub, id);
  }

  /** GET /voice/audit — tail the voice-audit ledger. */
  @Get("audit")
  audit(@Query("limit") limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    return this.voice.audit_tail(
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    );
  }
}
