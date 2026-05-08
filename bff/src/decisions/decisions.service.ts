import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";
import {
  DECISION_STATUSES,
  type DecisionStatus,
  type ListDecisionsDto,
} from "./dto/list-decisions.dto";
import type { UpdateDecisionDto } from "./dto/update-decision.dto";

const DEFAULT_TAKE = 100;
const MAX_TAKE = 500;

@Injectable()
export class DecisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(_userId: string, filter: ListDecisionsDto = {}) {
    // Single-tenant for now — every decision belongs to Roki.
    // Once multi-actor (e.g. assistants), add `where: { actorId: userId }`
    // (Class-A pattern from Dewx — every query scoped to the tenant).
    const take = Math.min(filter.take ?? DEFAULT_TAKE, MAX_TAKE);
    return this.prisma.decision.findMany({
      where: filter.status ? { status: filter.status } : undefined,
      orderBy: { createdAt: "desc" },
      take,
    });
  }

  async stats(_userId: string): Promise<Record<DecisionStatus, number>> {
    const grouped = await this.prisma.decision.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const counts = Object.fromEntries(DECISION_STATUSES.map((s) => [s, 0])) as Record<
      DecisionStatus,
      number
    >;
    for (const row of grouped) {
      if ((DECISION_STATUSES as readonly string[]).includes(row.status)) {
        counts[row.status as DecisionStatus] = row._count._all;
      }
    }
    return counts;
  }

  async get(_userId: string, id: string) {
    const decision = await this.prisma.decision.findUnique({ where: { id } });
    if (!decision) throw new NotFoundException("decision not found");
    return decision;
  }

  async update(userId: string, id: string, dto: UpdateDecisionDto) {
    const before = await this.get(userId, id); // 404 if missing
    const updated = await this.prisma.decision.update({
      where: { id },
      data: {
        status: dto.status,
        decidedAt: dto.status === "pending" ? null : new Date(),
      },
    });
    await this.audit.record(userId, `decision.${dto.status}`, id, {
      from: before.status,
      to: dto.status,
    });
    return updated;
  }
}
