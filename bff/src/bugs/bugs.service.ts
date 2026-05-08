import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { BugStatus, Prisma, Severity } from "@prisma/client";
import type { UserRole } from "@vibeos/auth";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";
import { BugStorageService, type UploadInput } from "./bug-storage.service";
import { BugSummaryService } from "./bug-summary.service";
import type { CreateBugDto } from "./dto/create-bug.dto";
import type { CreateCommentDto } from "./dto/create-comment.dto";
import type { ListBugsDto } from "./dto/list-bugs.dto";
import type { RegisterAppDto } from "./dto/register-app.dto";
import type { RegisterFeatureDto } from "./dto/register-feature.dto";
import type { UpdateBugDto } from "./dto/update-bug.dto";

const DEFAULT_TAKE = 100;
const MAX_TAKE = 500;

const TERMINAL_STATUSES = new Set<BugStatus>([
  "FIXED",
  "VERIFIED",
  "CLOSED",
  "WONT_FIX",
  "DUPLICATE",
]);

export interface CreateBugInputs {
  dto: CreateBugDto;
  reporter: string;
  reporterName?: string;
  screenshot?: UploadInput;
  video?: UploadInput;
}

export interface ActingUser {
  email: string;
  role: UserRole;
}

@Injectable()
export class BugsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: BugStorageService,
    private readonly audit: AuditService,
    private readonly summarizer: BugSummaryService,
  ) {}

  // ─── Apps ────────────────────────────────────────────────────────────

  listApps() {
    return this.prisma.app.findMany({ orderBy: { name: "asc" } });
  }

  async listFeatures(appId: string) {
    const app = await this.prisma.app.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("app not found");
    return this.prisma.appFeature.findMany({
      where: { appId },
      orderBy: { title: "asc" },
    });
  }

  /**
   * Single-shot catalog read for the testers' /bugs/catalog page and the
   * /bugs/new app+feature pickers. Returns every registered app with its
   * features inlined plus an open-bug count so the UI can surface where
   * testing is hot. Open = anything not in a terminal status.
   */
  async catalog() {
    const apps = await this.prisma.app.findMany({
      orderBy: { name: "asc" },
      include: { features: { orderBy: { title: "asc" } } },
    });

    if (apps.length === 0) return [];

    const appIds = apps.map((a) => a.id);
    const grouped = await this.prisma.bug.groupBy({
      by: ["appId"],
      where: {
        appId: { in: appIds },
        status: { notIn: Array.from(TERMINAL_STATUSES) },
      },
      _count: { _all: true },
    });
    const openByApp = new Map<string, number>(grouped.map((g) => [g.appId, g._count._all]));

    return apps.map((a) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      baseUrl: a.baseUrl,
      repoPath: a.repoPath,
      openBugCount: openByApp.get(a.id) ?? 0,
      features: a.features.map((f) => ({
        id: f.id,
        slug: f.slug,
        title: f.title,
        description: f.description,
        url: f.url,
        howto: f.howto,
        tags: f.tags,
      })),
    }));
  }

  async registerApp(actor: string, dto: RegisterAppDto) {
    const app = await this.prisma.app.upsert({
      where: { slug: dto.slug },
      create: {
        slug: dto.slug,
        name: dto.name,
        baseUrl: dto.baseUrl,
        repoPath: dto.repoPath ?? null,
      },
      update: {
        name: dto.name,
        baseUrl: dto.baseUrl,
        repoPath: dto.repoPath ?? null,
      },
    });
    await this.audit.record(actor, "bugs.app.registered", app.id, { slug: app.slug });
    return app;
  }

  async registerFeature(actor: string, appId: string, dto: RegisterFeatureDto) {
    const app = await this.prisma.app.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("app not found");

    const feature = await this.prisma.appFeature.upsert({
      where: { appId_slug: { appId, slug: dto.slug } },
      create: {
        appId,
        slug: dto.slug,
        title: dto.title,
        description: dto.description,
        url: dto.url,
        howto: dto.howto,
        tags: dto.tags ?? [],
      },
      update: {
        title: dto.title,
        description: dto.description,
        url: dto.url,
        howto: dto.howto,
        tags: dto.tags ?? [],
      },
    });
    await this.audit.record(actor, "bugs.feature.registered", feature.id, {
      appSlug: app.slug,
      slug: feature.slug,
    });
    return feature;
  }

  // ─── Bugs ────────────────────────────────────────────────────────────

  async create(actor: string, inputs: CreateBugInputs) {
    const { dto, reporter, reporterName, screenshot, video } = inputs;

    const app = await this.prisma.app.findUnique({ where: { slug: dto.appSlug } });
    if (!app) throw new BadRequestException(`unknown app slug: ${dto.appSlug}`);

    let featureId = dto.featureId ?? null;
    if (!featureId && dto.featureSlug) {
      const feature = await this.prisma.appFeature.findUnique({
        where: { appId_slug: { appId: app.id, slug: dto.featureSlug } },
      });
      if (!feature) {
        throw new BadRequestException(
          `unknown feature slug for app ${dto.appSlug}: ${dto.featureSlug}`,
        );
      }
      featureId = feature.id;
    } else if (featureId) {
      const feature = await this.prisma.appFeature.findUnique({ where: { id: featureId } });
      if (!feature || feature.appId !== app.id) {
        throw new BadRequestException("feature does not belong to the named app");
      }
    }

    // Pre-generate the id so we can write attachments to disk *before* the
    // Bug row exists. This avoids an UPDATE round-trip and means a partial
    // failure (file write fails) leaves no orphan DB row.
    const bugId = randomUUID();

    let screenshotUrl: string | null = null;
    let videoUrl: string | null = null;
    if (screenshot) {
      const stored = await this.storage.save(bugId, screenshot);
      screenshotUrl = stored.url;
    }
    if (video) {
      const stored = await this.storage.save(bugId, video);
      videoUrl = stored.url;
    }

    const bug = await this.prisma.bug.create({
      data: {
        id: bugId,
        title: dto.title,
        description: dto.description,
        severity: (dto.severity as Severity | undefined) ?? "P2",
        appId: app.id,
        featureId,
        reporter,
        reporterName: reporterName ?? null,
        consoleLog: dto.consoleLog ?? null,
        networkErrors: dto.networkErrors ?? null,
        screenshotUrl,
        videoUrl,
        url: dto.url ?? null,
        userAgent: dto.userAgent ?? null,
        viewportSize: dto.viewportSize ?? null,
      },
    });
    await this.audit.record(actor, "bugs.bug.created", bug.id, {
      appSlug: app.slug,
      severity: bug.severity,
    });
    return bug;
  }

  list(user: ActingUser, filter: ListBugsDto = {}) {
    const where: Prisma.BugWhereInput = {};
    if (filter.app) where.app = { slug: filter.app };
    if (filter.status) where.status = filter.status as BugStatus;
    if (filter.severity) where.severity = filter.severity as Severity;
    if (filter.claimedBy) where.claimedBy = filter.claimedBy;
    if (filter.reporter) where.reporter = filter.reporter;

    // Testers only ever see their own bugs — silently override any reporter
    // filter they sent to keep the contract obvious server-side.
    if (user.role === "tester") {
      where.reporter = user.email;
    }

    const take = Math.min(filter.take ?? DEFAULT_TAKE, MAX_TAKE);
    return this.prisma.bug.findMany({
      where,
      orderBy: { reportedAt: "desc" },
      take,
      include: { app: { select: { slug: true, name: true } } },
    });
  }

  async get(user: ActingUser, id: string) {
    const bug = await this.prisma.bug.findUnique({
      where: { id },
      include: {
        app: { select: { slug: true, name: true } },
        feature: { select: { slug: true, title: true } },
        comments: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!bug) throw new NotFoundException("bug not found");
    if (user.role === "tester" && bug.reporter !== user.email) {
      // Mask the existence of someone else's bug behind a 404.
      throw new NotFoundException("bug not found");
    }
    return bug;
  }

  async update(actor: string, id: string, dto: UpdateBugDto) {
    const before = await this.prisma.bug.findUnique({ where: { id } });
    if (!before) throw new NotFoundException("bug not found");

    const data: Prisma.BugUpdateInput = {};
    const audit: Record<string, Prisma.InputJsonValue | null> = {};

    if (dto.severity && dto.severity !== before.severity) {
      data.severity = dto.severity as Severity;
      audit.severity = { from: before.severity, to: dto.severity };
    }

    if (dto.claimedBy !== undefined && dto.claimedBy !== before.claimedBy) {
      data.claimedBy = dto.claimedBy || null;
      data.claimedAt = dto.claimedBy ? new Date() : null;
      audit.claimedBy = { from: before.claimedBy ?? null, to: dto.claimedBy || null };
    }

    if (dto.fixCommitSha !== undefined) {
      data.fixCommitSha = dto.fixCommitSha || null;
      audit.fixCommitSha = dto.fixCommitSha || null;
    }
    if (dto.fixBranch !== undefined) {
      data.fixBranch = dto.fixBranch || null;
      audit.fixBranch = dto.fixBranch || null;
    }
    if (dto.verifiedBy !== undefined) {
      data.verifiedBy = dto.verifiedBy || null;
      audit.verifiedBy = dto.verifiedBy || null;
    }

    if (dto.status && dto.status !== before.status) {
      const next = dto.status as BugStatus;
      data.status = next;
      audit.status = { from: before.status, to: next };
      if (next === "FIXED") data.fixedAt = new Date();
      if (next === "VERIFIED") data.verifiedAt = new Date();
      if (next === "OPEN") {
        // re-opening: clear terminal markers so the dashboard surfaces it again
        data.fixedAt = null;
        data.verifiedAt = null;
      }
    }

    if (Object.keys(data).length === 0) return before;

    const updated = await this.prisma.bug.update({ where: { id }, data });
    await this.audit.record(actor, "bugs.bug.updated", id, audit);
    return updated;
  }

  /**
   * Reporter-or-admin "verify fix" flip: FIXED → VERIFIED. Stamps
   * `verifiedAt = now` and `verifiedBy = user.email`.
   *
   * Narrower than the admin-only `update()` so a tester can close their
   * own loop the moment they confirm the fix lands. Refuses with:
   *   - 404 if the bug is missing OR the actor isn't the reporter (mask
   *     existence behind 404, same pattern as `get()`).
   *   - 403 if the actor is neither the reporter nor an admin.
   *   - 400 if the current status isn't FIXED — the dossier's state
   *     machine only allows FIXED → VERIFIED. Re-verifying when already
   *     VERIFIED is a no-op (idempotent).
   */
  async verifyFix(user: ActingUser, id: string) {
    const bug = await this.prisma.bug.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        reporter: true,
        verifiedAt: true,
        verifiedBy: true,
      },
    });
    if (!bug) throw new NotFoundException("bug not found");
    if (user.role === "tester" && bug.reporter !== user.email) {
      // mask existence
      throw new NotFoundException("bug not found");
    }
    if (user.role !== "admin" && bug.reporter !== user.email) {
      throw new ForbiddenException(
        "only the reporter (or an admin) may verify a fix",
      );
    }
    if (bug.status === "VERIFIED") {
      return this.prisma.bug.findUnique({
        where: { id },
        include: {
          app: { select: { slug: true, name: true } },
          feature: { select: { slug: true, title: true } },
          comments: { orderBy: { createdAt: "asc" } },
        },
      });
    }
    if (bug.status !== "FIXED") {
      throw new BadRequestException(
        `cannot verify a bug in status ${bug.status}; expected FIXED`,
      );
    }
    const now = new Date();
    const updated = await this.prisma.bug.update({
      where: { id },
      data: {
        status: "VERIFIED",
        verifiedAt: now,
        verifiedBy: user.email,
      },
      include: {
        app: { select: { slug: true, name: true } },
        feature: { select: { slug: true, title: true } },
        comments: { orderBy: { createdAt: "asc" } },
      },
    });
    await this.audit.record(user.email, "bugs.bug.verified", id, {
      from: "FIXED",
      to: "VERIFIED",
    });
    return updated;
  }

  /**
   * Iter-12: returns an AI-generated 2-sentence summary of the bug +
   * its comment thread, or `null` when summarization is skipped (the
   * BugSummaryService cost-gates trivial bugs and gracefully no-ops
   * when ANTHROPIC_API_KEY is missing or the call fails). Same access
   * rules as `get()` — testers only see their own bugs.
   */
  async getSummary(user: ActingUser, id: string) {
    const bug = await this.prisma.bug.findUnique({
      where: { id },
      include: { comments: { orderBy: { createdAt: "asc" } } },
    });
    if (!bug) throw new NotFoundException("bug not found");
    if (user.role === "tester" && bug.reporter !== user.email) {
      throw new NotFoundException("bug not found");
    }
    return this.summarizer.getSummary({ bug, comments: bug.comments });
  }

  // ─── Comments ─────────────────────────────────────────────────────────

  async addComment(user: ActingUser, bugId: string, dto: CreateCommentDto) {
    const bug = await this.prisma.bug.findUnique({
      where: { id: bugId },
      select: { id: true, reporter: true },
    });
    if (!bug) throw new NotFoundException("bug not found");
    if (user.role === "tester" && bug.reporter !== user.email) {
      throw new ForbiddenException("testers may only comment on their own bugs");
    }

    // Testers can't impersonate someone else (e.g. claude:tab-2). Admins can.
    const author = user.role === "admin" ? dto.author?.trim() || user.email : user.email;

    const comment = await this.prisma.bugComment.create({
      data: { bugId, author, body: dto.body },
    });
    await this.audit.record(user.email, "bugs.bug.commented", bugId, { commentId: comment.id });
    return comment;
  }
}
