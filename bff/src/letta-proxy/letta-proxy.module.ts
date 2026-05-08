import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LettaProxyController } from "./letta-proxy.controller";
import { LettaProxyService } from "./letta-proxy.service";

/**
 * LettaProxyModule — adapter between rokibrain BFF and Letta server (k3s).
 *
 * Wired by AppModule. Stub-mode if `LETTA_URL` is unset or unreachable —
 * see `letta-proxy.service.ts` for the fall-back contract. Module init never
 * crashes on missing Letta so dev boxes stay green.
 *
 * Phase 6 wires the persona memory loop:
 *   - dispatch.sh creates a Letta agent on first persona spawn
 *   - every inbox message is mirrored as a `sendMessage` call
 *   - status.json's `letta_agent_id` is the join key
 */
@Module({
  imports: [ConfigModule],
  controllers: [LettaProxyController],
  providers: [LettaProxyService],
  exports: [LettaProxyService],
})
export class LettaProxyModule {}
