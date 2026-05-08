import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DispatchController } from "./dispatch.controller";
import { DispatchService } from "./dispatch.service";

/**
 * DispatchModule — HTTP wrapper around `~/Projects/rokibrain/bin/dispatch.sh`.
 *
 * No DB-bound services here (yet) — dispatch state lives on disk in
 * persona inboxes + `state/dispatches.jsonl`. Once we move to a Prisma
 * `dispatches` table, import PrismaModule and inject PrismaService.
 *
 * To register: add `DispatchModule` to the `imports` array in `app.module.ts`.
 */
@Module({
  imports: [ConfigModule],
  controllers: [DispatchController],
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
