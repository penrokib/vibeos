import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "@vibeos/auth";
import { AuditService } from "./audit.service";

/**
 * Audit controller — read-only window into the audit log.
 *
 * Class-C bug-prevention: class-level @UseGuards(JwtAuthGuard).
 * Audit entries are sensitive (who tapped what), so this endpoint is never @Public().
 */
@Controller("audit")
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@CurrentUser("sub") _userId: string, @Query("limit") limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    return this.audit.list(Number.isFinite(parsed) ? (parsed as number) : undefined);
  }
}
