import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "@vibeos/database";

/**
 * AuditService — writes one row to `audit_events` per dashboard action.
 *
 * Channels Dewx's audit-trail pattern: every guard-protected mutation calls
 * `record()` so we can reconstruct who did what after the fact.
 *
 * `record()` never throws — a failed audit write must not roll back the
 * caller's mutation (per Dewx LEARNINGS: side-rails should never break the
 * golden path).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    actor: string,
    action: string,
    target?: string,
    payload?: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: { actor, action, target: target ?? null, payload: payload ?? undefined },
      });
    } catch (err) {
      this.logger.error(
        `audit write failed actor=${actor} action=${action}: ${(err as Error).message}`,
      );
    }
  }

  list(limit = 100) {
    return this.prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 500),
    });
  }
}
