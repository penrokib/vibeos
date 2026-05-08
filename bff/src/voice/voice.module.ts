import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuditModule } from "../audit/audit.module";
import { VoiceController } from "./voice.controller";
import { VoiceService } from "./voice.service";

/**
 * VoiceModule — receives voice utterances from iOS / Mac companion / Apple
 * Watch and routes them into the persona dispatch queue.
 *
 * Stub mode: full grammar parsing is deferred to Phase 6; this module
 * appends to `state/voice-pending.jsonl` and writes audit events. The real
 * router lives in the brain's grammar parser (handoffs/voice-arch).
 *
 * Hard wall: destructive verbs (delete, send, deploy, pay, ...) always
 * escalate to readback_tier=full. Auto-execute is never the default.
 */
@Module({
  imports: [ConfigModule, AuditModule],
  controllers: [VoiceController],
  providers: [VoiceService],
  exports: [VoiceService],
})
export class VoiceModule {}
