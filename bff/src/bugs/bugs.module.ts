import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditModule } from "../audit/audit.module";
import { BugStorageService, BUG_STORAGE_ROOT } from "./bug-storage.service";
import { BugSummaryService } from "./bug-summary.service";
import { BugsController } from "./bugs.controller";
import { BugsService } from "./bugs.service";

@Module({
  imports: [AuditModule],
  controllers: [BugsController],
  providers: [
    BugsService,
    BugSummaryService,
    BugStorageService,
    {
      provide: BUG_STORAGE_ROOT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>("BUG_STORAGE_ROOT") ?? "./storage/bugs",
    },
  ],
  exports: [BugsService],
})
export class BugsModule {}
