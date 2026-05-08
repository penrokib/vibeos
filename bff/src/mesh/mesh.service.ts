import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";
import type { CreateAccountDto } from "./dto/create-account.dto";
import {
  CreateDraftDto,
  ApproveDraftDto,
  RejectDraftDto,
} from "./dto/create-draft.dto";
import {
  ContactsQueryDto,
  CountersQueryDto,
  InboxQueryDto,
  ProfileQueryDto,
} from "./dto/inbox-query.dto";
import {
  MESH_COUNTER_BUCKETS,
  MESH_COUNTER_CAPS,
  type MeshCounterBucket,
  type MeshPlatform,
} from "./dto/platform.dto";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Anti-ban refusal — surfaces as HTTP 429 with a structured body the
 * client can parse without scraping a string. Keep the shape stable;
 * desktop daemon code in M04 keys off `error: "anti_ban_refusal"`.
 */
export class AntiBanRefusalException extends HttpException {
  constructor(reason: string, untilIso: string, counters: Record<string, number>) {
    super(
      {
        error: "anti_ban_refusal",
        reason,
        until_iso: untilIso,
        counters,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Bucket-start helpers. Buckets keyed by truncated time so the upsert
 * has a deterministic primary-key target. Mirrors §3 SQL.
 */
function bucketStart(bucket: MeshCounterBucket, now: Date): Date {
  const d = new Date(now.getTime());
  switch (bucket) {
    case "minute":
    case "burst_60s":
      d.setUTCSeconds(0, 0);
      return d;
    case "hour":
      d.setUTCMinutes(0, 0, 0);
      return d;
    case "day":
    case "unwarmed_day":
      d.setUTCHours(0, 0, 0, 0);
      return d;
  }
}

function bucketResetIso(bucket: MeshCounterBucket, start: Date): string {
  const ms = start.getTime();
  const next = new Date(ms);
  switch (bucket) {
    case "minute":
    case "burst_60s":
      next.setUTCMinutes(next.getUTCMinutes() + 1);
      break;
    case "hour":
      next.setUTCHours(next.getUTCHours() + 1);
      break;
    case "day":
    case "unwarmed_day":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
  }
  return next.toISOString();
}

@Injectable()
export class MeshService {
  private readonly logger = new Logger(MeshService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────────────────────────────────────────────────────
  // Account resolution helpers
  // ────────────────────────────────────────────────────────────────────

  /** Resolve an account by id, or by external_id (`+60xxxx`, `@handle`, email). */
  async resolveAccount(platform: MeshPlatform | null, accountKey: string) {
    const acct = await this.prisma.meshAccount.findFirst({
      where: {
        OR: [
          // Try id only when it looks like a UUID (avoids Prisma cast errors).
          accountKey.length === 36
            ? { id: accountKey }
            : { id: "00000000-0000-0000-0000-000000000000" },
          {
            externalId: accountKey,
            ...(platform ? { platform } : {}),
          },
        ],
      },
    });
    if (!acct)
      throw new NotFoundException(
        `mesh account not found: ${accountKey}${platform ? ` (${platform})` : ""}`,
      );
    if (platform && acct.platform !== platform) {
      throw new BadRequestException(
        `account ${accountKey} is on platform=${acct.platform}, expected ${platform}`,
      );
    }
    return acct;
  }

  // ────────────────────────────────────────────────────────────────────
  // Inbox / profile / contacts (read-only)
  // ────────────────────────────────────────────────────────────────────

  async listInbox(platform: MeshPlatform, q: InboxQueryDto) {
    const acct = await this.resolveAccount(platform, q.account);
    const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    return this.prisma.meshMessage.findMany({
      where: {
        accountId: acct.id,
        ...(q.after ? { ts: { gt: new Date(q.after) } } : {}),
      },
      orderBy: { ts: "desc" },
      take: limit,
    });
  }

  async getProfile(platform: MeshPlatform, q: ProfileQueryDto) {
    const acct = await this.resolveAccount(platform, q.account);
    return {
      id: acct.id,
      platform: acct.platform,
      label: acct.label,
      external_id: acct.externalId,
      country_cc: acct.countryCc,
      status: acct.status,
      frozen_until: acct.frozenUntil,
      paired_at: acct.pairedAt,
      last_active_at: acct.lastActiveAt,
    };
  }

  async listContacts(platform: MeshPlatform, q: ContactsQueryDto) {
    const acct = await this.resolveAccount(platform, q.account);
    const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    return this.prisma.meshContact.findMany({
      where: {
        accountId: acct.id,
        ...(q.q
          ? {
              OR: [
                { displayName: { contains: q.q, mode: "insensitive" } },
                { externalId: { contains: q.q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastMsgAt: "desc" }, { firstSeenAt: "desc" }],
      take: limit,
    });
  }

  /**
   * Health check — returns counts of accounts by status and frozen accounts.
   * Cheap; safe for an unauthenticated probe (still gated at controller via JWT).
   */
  async health() {
    const [total, frozen, banned, connected] = await Promise.all([
      this.prisma.meshAccount.count(),
      this.prisma.meshAccount.count({ where: { status: "frozen" } }),
      this.prisma.meshAccount.count({ where: { status: "banned" } }),
      this.prisma.meshAccount.count({ where: { status: "connected" } }),
    ]);
    return {
      ok: true,
      accounts: { total, frozen, banned, connected },
      ts: new Date().toISOString(),
    };
  }

  async getCounters(q: CountersQueryDto) {
    const acct = await this.resolveAccount(null, q.account);
    return this.prisma.meshCounter.findMany({
      where: {
        accountId: acct.id,
        ...(q.since ? { bucketStart: { gte: new Date(q.since) } } : {}),
      },
      orderBy: { bucketStart: "desc" },
      take: 500,
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Anti-ban counters — atomic upsert + cap check (§3)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Atomically increment every applicable bucket for an account; if ANY
   * bucket exceeds its cap, throw AntiBanRefusalException with the first
   * tripped reason. Caller wraps the send attempt; refusal blocks send.
   *
   * NEVER bypassed — design §10 hardwall #16 forbids a force-send flag.
   */
  async incrementCounters(
    accountId: string,
    opts: { unwarmed?: boolean; capsOverride?: Partial<Record<MeshCounterBucket, number>> } = {},
  ): Promise<{ ok: true; counters: Record<MeshCounterBucket, number> } | never> {
    const now = new Date();
    const buckets: MeshCounterBucket[] = ["minute", "hour", "day", "burst_60s"];
    if (opts.unwarmed) buckets.push("unwarmed_day");

    const caps: Record<MeshCounterBucket, number> = {
      ...MESH_COUNTER_CAPS,
      ...(opts.capsOverride ?? {}),
    };

    const result: Record<string, number> = {};
    let tripped: { bucket: MeshCounterBucket; count: number; cap: number } | null = null;

    // Run as a transaction so a tripped-bucket rollback un-does prior upserts
    // in the same call. Without this, a minute upsert that succeeds before
    // the hour upsert that trips would leave a stale +1 minute count.
    await this.prisma.$transaction(async (tx) => {
      for (const bucket of buckets) {
        const start = bucketStart(bucket, now);
        const row = await tx.meshCounter.upsert({
          where: {
            accountId_bucket_bucketStart: {
              accountId,
              bucket,
              bucketStart: start,
            },
          },
          create: { accountId, bucket, bucketStart: start, count: 1 },
          update: { count: { increment: 1 } },
        });
        result[bucket] = row.count;
        const cap = caps[bucket];
        if (row.count > cap) {
          tripped = { bucket, count: row.count, cap };
          // Force the transaction to roll back so the over-cap row reverts.
          throw new Error("__anti_ban_rollback__");
        }
      }
    }).catch((err) => {
      if ((err as Error).message !== "__anti_ban_rollback__") throw err;
    });

    // Cast away TS's closure-narrowing — the inner async assigns `tripped`,
    // but the control-flow analyzer doesn't see through the lambda.
    const trippedSnapshot = tripped as
      | { bucket: MeshCounterBucket; count: number; cap: number }
      | null;
    if (trippedSnapshot) {
      // burst_60s additionally freezes the account 10 minutes per §3.
      if (trippedSnapshot.bucket === "burst_60s") {
        const freezeUntil = new Date(now.getTime() + 10 * 60_000);
        await this.prisma.meshAccount.update({
          where: { id: accountId },
          data: { status: "frozen", frozenUntil: freezeUntil },
        });
      }
      const start = bucketStart(trippedSnapshot.bucket, now);
      throw new AntiBanRefusalException(
        `${trippedSnapshot.bucket}_cap_exceeded`,
        bucketResetIso(trippedSnapshot.bucket, start),
        result,
      );
    }

    return { ok: true, counters: result as Record<MeshCounterBucket, number> };
  }

  // ────────────────────────────────────────────────────────────────────
  // Drafts: queue / approve / reject
  // ────────────────────────────────────────────────────────────────────

  /**
   * Queue a draft for approval. §10 hardwall: this MUST run anti-ban gate
   * checks; we perform a DRY-RUN counter check (read current bucket values
   * without incrementing) so that drafts created during a frozen window
   * are refused at queue time, not approval time. The actual increment
   * happens on approve, just before the mesh child fires the send.
   */
  async createDraft(platform: MeshPlatform, dto: CreateDraftDto) {
    const acct = await this.resolveAccount(platform, dto.account);

    // Frozen-account hardwall.
    if (acct.status === "frozen" && acct.frozenUntil && acct.frozenUntil > new Date()) {
      throw new AntiBanRefusalException(
        "account_frozen",
        acct.frozenUntil.toISOString(),
        {},
      );
    }
    if (acct.status === "banned") {
      throw new ForbiddenException("account_banned");
    }

    // Similarity hardwall (§3): reject if the persona pre-computed it ≥ 0.85.
    if (dto.similarityScore !== undefined && dto.similarityScore >= 0.85) {
      throw new BadRequestException({
        error: "similarity_too_high",
        threshold: 0.85,
        observed: dto.similarityScore,
      });
    }

    // Read-only counter peek: if any bucket is already at cap, refuse the
    // draft preemptively. This is NOT a bypass of the increment — that
    // happens at approve-time. Class-of-error guard: §10 #16.
    await this.peekCounters(acct.id);

    const draft = await this.prisma.meshDraft.create({
      data: {
        accountId: acct.id,
        contactExternalId: dto.to,
        body: dto.body,
        personaSlug: dto.personaSlug,
        similarityScore: dto.similarityScore ?? null,
      },
    });

    await this.prisma.meshActionLog.create({
      data: {
        accountId: acct.id,
        action: "draft.queued",
        payload: {
          draft_id: draft.id,
          persona: dto.personaSlug ?? null,
          to: dto.to,
        },
      },
    });

    return draft;
  }

  /**
   * Read-only counter check. Throws AntiBanRefusalException if any bucket
   * is already AT or OVER its cap. Use before queueing a draft.
   */
  private async peekCounters(accountId: string): Promise<void> {
    const now = new Date();
    for (const bucket of MESH_COUNTER_BUCKETS) {
      const start = bucketStart(bucket, now);
      const row = await this.prisma.meshCounter.findUnique({
        where: {
          accountId_bucket_bucketStart: {
            accountId,
            bucket,
            bucketStart: start,
          },
        },
      });
      const count = row?.count ?? 0;
      const cap = MESH_COUNTER_CAPS[bucket];
      if (count >= cap) {
        throw new AntiBanRefusalException(
          `${bucket}_cap_exceeded`,
          bucketResetIso(bucket, start),
          { [bucket]: count },
        );
      }
    }
  }

  async approveDraft(id: string, dto: ApproveDraftDto, userIdForAudit: string) {
    if (!dto.approverEmail) {
      // Belt-and-braces — the DTO already requires approverEmail, but if a
      // controller-level bypass ever lands this is the second wall.
      throw new BadRequestException("approver_email required (§10 hardwall)");
    }
    const draft = await this.prisma.meshDraft.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException("draft not found");
    if (draft.approvedAt) throw new BadRequestException("draft already approved");
    if (draft.rejectedAt) throw new BadRequestException("draft already rejected");

    // Increment (and trip-check) anti-ban counters BEFORE marking approved.
    // If this throws 429, the draft stays pending and the approver can retry
    // after the bucket resets.
    await this.incrementCounters(draft.accountId);

    const updated = await this.prisma.meshDraft.update({
      where: { id },
      data: { approvedAt: new Date(), approvedBy: dto.approverEmail },
    });

    await this.prisma.meshActionLog.create({
      data: {
        accountId: draft.accountId,
        action: "draft.approve",
        payload: { draft_id: id, approver: dto.approverEmail },
      },
    });
    await this.audit.record(userIdForAudit, "mesh.draft.approve", id, {
      approver: dto.approverEmail,
      account_id: draft.accountId,
    });

    return updated;
  }

  async rejectDraft(id: string, dto: RejectDraftDto, userIdForAudit: string) {
    const draft = await this.prisma.meshDraft.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException("draft not found");
    if (draft.approvedAt) throw new BadRequestException("draft already approved");
    if (draft.rejectedAt) throw new BadRequestException("draft already rejected");

    const updated = await this.prisma.meshDraft.update({
      where: { id },
      data: {
        rejectedAt: new Date(),
        rejectedBy: dto.rejectorEmail,
        refusedReasons: dto.reason ? { reason: dto.reason } : undefined,
      },
    });

    await this.prisma.meshActionLog.create({
      data: {
        accountId: draft.accountId,
        action: "draft.reject",
        payload: { draft_id: id, by: dto.rejectorEmail, reason: dto.reason },
      },
    });
    await this.audit.record(userIdForAudit, "mesh.draft.reject", id, {
      by: dto.rejectorEmail,
      reason: dto.reason,
    });

    return updated;
  }

  async listPendingDrafts(limit = 100) {
    return this.prisma.meshDraft.findMany({
      where: { approvedAt: null, rejectedAt: null },
      orderBy: { createdAt: "asc" },
      take: Math.min(limit, MAX_LIMIT),
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Account registration
  // ────────────────────────────────────────────────────────────────────

  async createAccount(dto: CreateAccountDto, ownerEmailFromJwt: string) {
    const owner = (dto.ownerEmail ?? ownerEmailFromJwt).toLowerCase();
    // device_id existence is enforced by FK; we surface a clearer 404.
    const device = await this.prisma.deviceAppInstall.findUnique({
      where: { id: dto.deviceId },
    });
    if (!device)
      throw new NotFoundException(`device_app_install not found: ${dto.deviceId}`);

    const acct = await this.prisma.meshAccount.create({
      data: {
        ownerEmail: owner,
        platform: dto.platform,
        deviceId: dto.deviceId,
        label: dto.label,
        externalId: dto.externalId,
        countryCc: dto.countryCc,
        policyJson: (dto.policyJson ?? {}) as never,
      },
    });

    await this.prisma.meshActionLog.create({
      data: {
        accountId: acct.id,
        action: "pair",
        payload: { label: dto.label, platform: dto.platform },
      },
    });

    return acct;
  }
}
