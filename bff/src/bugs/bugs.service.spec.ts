import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";
import { BugStorageService } from "./bug-storage.service";
import { BugSummaryService } from "./bug-summary.service";
import { BugsService, type ActingUser } from "./bugs.service";

const ADMIN: ActingUser = { email: "roki@example.com", role: "admin" };
const TESTER: ActingUser = { email: "tester@example.com", role: "tester" };

type BugRow = {
  id: string;
  title: string;
  description: string;
  severity: "P0" | "P1" | "P2" | "P3";
  status:
    | "OPEN"
    | "CLAIMED"
    | "IN_PROGRESS"
    | "FIXED"
    | "VERIFIED"
    | "CLOSED"
    | "WONT_FIX"
    | "DUPLICATE";
  appId: string;
  featureId: string | null;
  reporter: string;
  reporterName: string | null;
  reportedAt: Date;
  claimedBy: string | null;
  claimedAt: Date | null;
  fixedAt: Date | null;
  fixCommitSha: string | null;
  fixBranch: string | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  consoleLog: string | null;
  networkErrors: string | null;
  screenshotUrl: string | null;
  videoUrl: string | null;
  url: string | null;
  userAgent: string | null;
  viewportSize: string | null;
};

const makeBug = (overrides: Partial<BugRow> = {}): BugRow => ({
  id: "bug-1",
  title: "Login broken",
  description: "Clicking login does nothing",
  severity: "P2",
  status: "OPEN",
  appId: "app-1",
  featureId: null,
  reporter: "tester@example.com",
  reporterName: null,
  reportedAt: new Date("2026-05-04T10:00:00Z"),
  claimedBy: null,
  claimedAt: null,
  fixedAt: null,
  fixCommitSha: null,
  fixBranch: null,
  verifiedBy: null,
  verifiedAt: null,
  consoleLog: null,
  networkErrors: null,
  screenshotUrl: null,
  videoUrl: null,
  url: null,
  userAgent: null,
  viewportSize: null,
  ...overrides,
});

describe("BugsService", () => {
  let service: BugsService;
  let prisma: {
    app: jest.Mocked<{ findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock }>;
    appFeature: jest.Mocked<{ findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock }>;
    bug: jest.Mocked<{
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      groupBy: jest.Mock;
      update: jest.Mock;
    }>;
    bugComment: jest.Mocked<{ create: jest.Mock }>;
  };
  let storage: jest.Mocked<Pick<BugStorageService, "save">>;
  let audit: jest.Mocked<Pick<AuditService, "record">>;

  beforeEach(async () => {
    prisma = {
      app: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
      } as never,
      appFeature: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
      } as never,
      bug: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        groupBy: jest.fn(),
        update: jest.fn(),
      } as never,
      bugComment: {
        create: jest.fn(),
      } as never,
    };
    storage = {
      save: jest.fn().mockResolvedValue({ url: "/storage/bugs/x/screenshot.png", size: 100 }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const summarizer: jest.Mocked<Pick<BugSummaryService, "getSummary">> = {
      getSummary: jest.fn().mockResolvedValue(null),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BugsService,
        { provide: PrismaService, useValue: prisma },
        { provide: BugStorageService, useValue: storage },
        { provide: AuditService, useValue: audit },
        { provide: BugSummaryService, useValue: summarizer },
      ],
    }).compile();

    service = moduleRef.get(BugsService);
  });

  // ─── listApps / listFeatures ──────────────────────────────────────────

  describe("listApps", () => {
    it("returns every app ordered by name asc", async () => {
      const rows = [
        { id: "a-1", slug: "dewx", name: "Dewx" },
        { id: "a-2", slug: "kidiq", name: "KidIQ" },
      ];
      prisma.app.findMany.mockResolvedValue(rows);

      const result = await service.listApps();

      expect(prisma.app.findMany).toHaveBeenCalledWith({ orderBy: { name: "asc" } });
      expect(result).toBe(rows);
    });
  });

  describe("listFeatures", () => {
    it("404s when the app does not exist", async () => {
      prisma.app.findUnique.mockResolvedValue(null);

      await expect(service.listFeatures("missing")).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.appFeature.findMany).not.toHaveBeenCalled();
    });

    it("returns the app's features ordered by title asc", async () => {
      prisma.app.findUnique.mockResolvedValue({ id: "app-1", slug: "dewx" });
      const rows = [{ id: "f-1", appId: "app-1", slug: "create", title: "Create" }];
      prisma.appFeature.findMany.mockResolvedValue(rows);

      const result = await service.listFeatures("app-1");

      expect(prisma.appFeature.findMany).toHaveBeenCalledWith({
        where: { appId: "app-1" },
        orderBy: { title: "asc" },
      });
      expect(result).toBe(rows);
    });
  });

  // ─── catalog ──────────────────────────────────────────────────────────

  describe("catalog", () => {
    it("returns [] without hitting groupBy when there are no apps", async () => {
      prisma.app.findMany.mockResolvedValue([]);

      const result = await service.catalog();

      expect(result).toEqual([]);
      expect(prisma.bug.groupBy).not.toHaveBeenCalled();
    });

    it("inlines features and stitches in open-bug counts per app", async () => {
      prisma.app.findMany.mockResolvedValue([
        {
          id: "app-1",
          slug: "dewx",
          name: "Dewx",
          baseUrl: "https://app.dewx.com",
          repoPath: null,
          features: [
            {
              id: "f-1",
              slug: "campaigns_create",
              title: "Create campaign",
              description: "...",
              url: "https://app.dewx.com/c/new",
              howto: "Click +",
              tags: ["outreach"],
            },
          ],
        },
        {
          id: "app-2",
          slug: "kidiq",
          name: "KidIQ",
          baseUrl: "https://kidiq.app",
          repoPath: "kidiq",
          features: [],
        },
      ]);
      prisma.bug.groupBy.mockResolvedValue([{ appId: "app-1", _count: { _all: 3 } }]);

      const result = await service.catalog();

      expect(prisma.app.findMany).toHaveBeenCalledWith({
        orderBy: { name: "asc" },
        include: { features: { orderBy: { title: "asc" } } },
      });
      expect(prisma.bug.groupBy).toHaveBeenCalledWith({
        by: ["appId"],
        where: {
          appId: { in: ["app-1", "app-2"] },
          status: { notIn: ["FIXED", "VERIFIED", "CLOSED", "WONT_FIX", "DUPLICATE"] },
        },
        _count: { _all: true },
      });
      expect(result).toEqual([
        {
          id: "app-1",
          slug: "dewx",
          name: "Dewx",
          baseUrl: "https://app.dewx.com",
          repoPath: null,
          openBugCount: 3,
          features: [
            {
              id: "f-1",
              slug: "campaigns_create",
              title: "Create campaign",
              description: "...",
              url: "https://app.dewx.com/c/new",
              howto: "Click +",
              tags: ["outreach"],
            },
          ],
        },
        {
          id: "app-2",
          slug: "kidiq",
          name: "KidIQ",
          baseUrl: "https://kidiq.app",
          repoPath: "kidiq",
          openBugCount: 0,
          features: [],
        },
      ]);
    });
  });

  // ─── registerApp ──────────────────────────────────────────────────────

  describe("registerApp", () => {
    it("upserts on slug and writes an audit row", async () => {
      const dto = { slug: "dewx", name: "Dewx", baseUrl: "https://app.dewx.com" };
      const created = { id: "app-1", ...dto, repoPath: null, createdAt: new Date() };
      prisma.app.upsert.mockResolvedValue(created);

      const result = await service.registerApp("roki", dto);

      expect(prisma.app.upsert).toHaveBeenCalledWith({
        where: { slug: "dewx" },
        create: { slug: "dewx", name: "Dewx", baseUrl: "https://app.dewx.com", repoPath: null },
        update: { name: "Dewx", baseUrl: "https://app.dewx.com", repoPath: null },
      });
      expect(audit.record).toHaveBeenCalledWith("roki", "bugs.app.registered", "app-1", {
        slug: "dewx",
      });
      expect(result).toBe(created);
    });
  });

  // ─── listApps / listFeatures ──────────────────────────────────────────

  describe("listApps", () => {
    it("returns all apps ordered by name asc", async () => {
      const rows = [{ id: "a", slug: "dewx", name: "Dewx" }];
      prisma.app.findMany.mockResolvedValue(rows);

      const result = await service.listApps();

      expect(prisma.app.findMany).toHaveBeenCalledWith({ orderBy: { name: "asc" } });
      expect(result).toBe(rows);
    });
  });

  describe("listFeatures", () => {
    it("404s when the app does not exist", async () => {
      prisma.app.findUnique.mockResolvedValue(null);

      await expect(service.listFeatures("missing")).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.appFeature.findMany).not.toHaveBeenCalled();
    });

    it("returns the app's features ordered by title asc", async () => {
      prisma.app.findUnique.mockResolvedValue({ id: "app-1", slug: "dewx" });
      const rows = [{ id: "f-1", appId: "app-1", slug: "create", title: "Create" }];
      prisma.appFeature.findMany.mockResolvedValue(rows);

      const result = await service.listFeatures("app-1");

      expect(prisma.appFeature.findMany).toHaveBeenCalledWith({
        where: { appId: "app-1" },
        orderBy: { title: "asc" },
      });
      expect(result).toBe(rows);
    });
  });

  // ─── registerFeature ──────────────────────────────────────────────────

  describe("registerFeature", () => {
    it("404s when the app does not exist", async () => {
      prisma.app.findUnique.mockResolvedValue(null);

      await expect(
        service.registerFeature("roki", "missing", {
          slug: "x",
          title: "x",
          description: "x",
          url: "x",
          howto: "x",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.appFeature.upsert).not.toHaveBeenCalled();
    });

    it("upserts on (appId, slug) and audits", async () => {
      prisma.app.findUnique.mockResolvedValue({ id: "app-1", slug: "dewx" });
      const feature = { id: "f-1", appId: "app-1", slug: "campaigns_create", tags: [] };
      prisma.appFeature.upsert.mockResolvedValue(feature);

      const result = await service.registerFeature("roki", "app-1", {
        slug: "campaigns_create",
        title: "Create campaign",
        description: "...",
        url: "https://app.dewx.com/c/new",
        howto: "Click +",
        tags: ["outreach"],
      });

      expect(prisma.appFeature.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { appId_slug: { appId: "app-1", slug: "campaigns_create" } },
          create: expect.objectContaining({ tags: ["outreach"] }),
          update: expect.objectContaining({ tags: ["outreach"] }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith("roki", "bugs.feature.registered", "f-1", {
        appSlug: "dewx",
        slug: "campaigns_create",
      });
      expect(result).toBe(feature);
    });

    it("defaults tags to [] when omitted", async () => {
      prisma.app.findUnique.mockResolvedValue({ id: "app-1", slug: "dewx" });
      prisma.appFeature.upsert.mockResolvedValue({ id: "f-1", appId: "app-1", slug: "x" });

      await service.registerFeature("roki", "app-1", {
        slug: "x",
        title: "x",
        description: "x",
        url: "x",
        howto: "x",
      });

      const call = prisma.appFeature.upsert.mock.calls[0][0];
      expect(call.create.tags).toEqual([]);
      expect(call.update.tags).toEqual([]);
    });
  });

  // ─── create ───────────────────────────────────────────────────────────

  describe("create", () => {
    const baseDto = {
      title: "Bug",
      description: "It broke",
      appSlug: "dewx",
    };

    it("rejects an unknown app slug with 400", async () => {
      prisma.app.findUnique.mockResolvedValue(null);

      await expect(
        service.create("roki", { dto: baseDto, reporter: "r@example.com" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bug.create).not.toHaveBeenCalled();
    });

    it("rejects a feature slug that does not exist for the app", async () => {
      prisma.app.findUnique.mockResolvedValue({ id: "app-1", slug: "dewx" });
      prisma.appFeature.findUnique.mockResolvedValue(null);

      await expect(
        service.create("roki", {
          dto: { ...baseDto, featureSlug: "missing" },
          reporter: "r@example.com",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a featureId belonging to a different app", async () => {
      prisma.app.findUnique.mockResolvedValue({ id: "app-1", slug: "dewx" });
      prisma.appFeature.findUnique.mockResolvedValue({ id: "f-1", appId: "OTHER" });

      await expect(
        service.create("roki", {
          dto: { ...baseDto, featureId: "f-1" },
          reporter: "r@example.com",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("writes screenshot+video then creates the bug row with both URLs", async () => {
      prisma.app.findUnique.mockResolvedValue({ id: "app-1", slug: "dewx" });
      prisma.bug.create.mockImplementation(({ data }) =>
        Promise.resolve({ ...makeBug(), ...data }),
      );
      storage.save
        .mockResolvedValueOnce({ url: "/storage/bugs/X/screenshot.png", size: 1 })
        .mockResolvedValueOnce({ url: "/storage/bugs/X/video.webm", size: 2 });

      const result = await service.create("roki", {
        dto: baseDto,
        reporter: "tester@example.com",
        screenshot: {
          fieldname: "screenshot",
          originalname: "shot.png",
          mimetype: "image/png",
          buffer: Buffer.from(""),
          size: 1,
        },
        video: {
          fieldname: "video",
          originalname: "v.webm",
          mimetype: "video/webm",
          buffer: Buffer.from(""),
          size: 2,
        },
      });

      expect(storage.save).toHaveBeenCalledTimes(2);
      const createCall = prisma.bug.create.mock.calls[0][0];
      expect(createCall.data.screenshotUrl).toBe("/storage/bugs/X/screenshot.png");
      expect(createCall.data.videoUrl).toBe("/storage/bugs/X/video.webm");
      expect(createCall.data.severity).toBe("P2");
      expect(createCall.data.appId).toBe("app-1");
      expect(createCall.data.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(audit.record).toHaveBeenCalledWith(
        "roki",
        "bugs.bug.created",
        result.id,
        expect.objectContaining({ appSlug: "dewx" }),
      );
    });

    it("defaults severity to P2 when omitted", async () => {
      prisma.app.findUnique.mockResolvedValue({ id: "app-1", slug: "dewx" });
      prisma.bug.create.mockImplementation(({ data }) =>
        Promise.resolve({ ...makeBug(), ...data }),
      );

      await service.create("roki", { dto: baseDto, reporter: "r@example.com" });

      expect(prisma.bug.create.mock.calls[0][0].data.severity).toBe("P2");
    });

    it("does not call storage when no files are attached", async () => {
      prisma.app.findUnique.mockResolvedValue({ id: "app-1", slug: "dewx" });
      prisma.bug.create.mockImplementation(({ data }) =>
        Promise.resolve({ ...makeBug(), ...data }),
      );

      await service.create("roki", { dto: baseDto, reporter: "r@example.com" });

      expect(storage.save).not.toHaveBeenCalled();
    });
  });

  // ─── list ─────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns up to 100 rows ordered by reportedAt desc with empty filters (admin)", async () => {
      const rows = [makeBug()];
      prisma.bug.findMany.mockResolvedValue(rows);

      const result = await service.list(ADMIN);

      expect(prisma.bug.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { reportedAt: "desc" },
        take: 100,
        include: { app: { select: { slug: true, name: true } } },
      });
      expect(result).toBe(rows);
    });

    it("translates app slug into a relational where clause", async () => {
      prisma.bug.findMany.mockResolvedValue([]);

      await service.list(ADMIN, {
        app: "dewx",
        status: "OPEN",
        severity: "P0",
        claimedBy: "tab-2",
      });

      const call = prisma.bug.findMany.mock.calls[0][0];
      expect(call.where).toEqual({
        app: { slug: "dewx" },
        status: "OPEN",
        severity: "P0",
        claimedBy: "tab-2",
      });
    });

    it("caps take at 500", async () => {
      prisma.bug.findMany.mockResolvedValue([]);

      await service.list(ADMIN, { take: 9999 });

      expect(prisma.bug.findMany.mock.calls[0][0].take).toBe(500);
    });

    it("forces reporter=tester.email when caller is a tester", async () => {
      prisma.bug.findMany.mockResolvedValue([]);

      await service.list(TESTER, { app: "dewx" });

      expect(prisma.bug.findMany.mock.calls[0][0].where).toEqual({
        app: { slug: "dewx" },
        reporter: TESTER.email,
      });
    });

    it("ignores a tester's attempt to filter by another reporter", async () => {
      prisma.bug.findMany.mockResolvedValue([]);

      await service.list(TESTER, { reporter: "someone-else@example.com" });

      expect(prisma.bug.findMany.mock.calls[0][0].where.reporter).toBe(TESTER.email);
    });
  });

  // ─── get ──────────────────────────────────────────────────────────────

  describe("get", () => {
    it("404s when missing", async () => {
      prisma.bug.findUnique.mockResolvedValue(null);

      await expect(service.get(ADMIN, "missing")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns the bug with related app/feature/comments for admins", async () => {
      const bug = { ...makeBug(), comments: [] };
      prisma.bug.findUnique.mockResolvedValue(bug);

      const result = await service.get(ADMIN, "bug-1");

      expect(prisma.bug.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "bug-1" },
          include: expect.objectContaining({
            app: { select: { slug: true, name: true } },
            feature: { select: { slug: true, title: true } },
            comments: { orderBy: { createdAt: "asc" } },
          }),
        }),
      );
      expect(result).toBe(bug);
    });

    it("404s for testers viewing someone else's bug", async () => {
      prisma.bug.findUnique.mockResolvedValue({ ...makeBug(), reporter: "other@example.com" });

      await expect(service.get(TESTER, "bug-1")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns the bug for testers viewing their own", async () => {
      const bug = { ...makeBug(), reporter: TESTER.email, comments: [] };
      prisma.bug.findUnique.mockResolvedValue(bug);

      await expect(service.get(TESTER, "bug-1")).resolves.toBe(bug);
    });
  });

  // ─── update ───────────────────────────────────────────────────────────

  describe("update", () => {
    it("404s when the bug does not exist", async () => {
      prisma.bug.findUnique.mockResolvedValue(null);

      await expect(service.update("roki", "missing", { status: "FIXED" })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.bug.update).not.toHaveBeenCalled();
    });

    it("transitioning to FIXED stamps fixedAt", async () => {
      prisma.bug.findUnique.mockResolvedValue(makeBug({ status: "IN_PROGRESS" }));
      prisma.bug.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...makeBug(), ...data }),
      );

      await service.update("roki", "bug-1", { status: "FIXED", fixCommitSha: "abc1234" });

      const call = prisma.bug.update.mock.calls[0][0];
      expect(call.data.status).toBe("FIXED");
      expect(call.data.fixedAt).toBeInstanceOf(Date);
      expect(call.data.fixCommitSha).toBe("abc1234");
    });

    it("transitioning to VERIFIED stamps verifiedAt", async () => {
      prisma.bug.findUnique.mockResolvedValue(makeBug({ status: "FIXED" }));
      prisma.bug.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...makeBug(), ...data }),
      );

      await service.update("roki", "bug-1", { status: "VERIFIED", verifiedBy: "tester@x.com" });

      const call = prisma.bug.update.mock.calls[0][0];
      expect(call.data.verifiedAt).toBeInstanceOf(Date);
      expect(call.data.verifiedBy).toBe("tester@x.com");
    });

    it("re-opening clears fixedAt and verifiedAt", async () => {
      prisma.bug.findUnique.mockResolvedValue(
        makeBug({ status: "VERIFIED", fixedAt: new Date(), verifiedAt: new Date() }),
      );
      prisma.bug.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...makeBug(), ...data }),
      );

      await service.update("roki", "bug-1", { status: "OPEN" });

      const call = prisma.bug.update.mock.calls[0][0];
      expect(call.data.status).toBe("OPEN");
      expect(call.data.fixedAt).toBeNull();
      expect(call.data.verifiedAt).toBeNull();
    });

    it("setting claimedBy stamps claimedAt; clearing it nulls both", async () => {
      prisma.bug.findUnique.mockResolvedValue(makeBug());
      prisma.bug.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...makeBug(), ...data }),
      );

      await service.update("roki", "bug-1", { claimedBy: "tab-2" });
      let call = prisma.bug.update.mock.calls[0][0];
      expect(call.data.claimedBy).toBe("tab-2");
      expect(call.data.claimedAt).toBeInstanceOf(Date);

      prisma.bug.findUnique.mockResolvedValue(
        makeBug({ claimedBy: "tab-2", claimedAt: new Date() }),
      );
      await service.update("roki", "bug-1", { claimedBy: "" });
      call = prisma.bug.update.mock.calls[1][0];
      expect(call.data.claimedBy).toBeNull();
      expect(call.data.claimedAt).toBeNull();
    });

    it("returns the unchanged row without an UPDATE when nothing changed", async () => {
      const before = makeBug({ status: "OPEN" });
      prisma.bug.findUnique.mockResolvedValue(before);

      const result = await service.update("roki", "bug-1", { status: "OPEN" });

      expect(prisma.bug.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(result).toBe(before);
    });

    it("audits a status change with from/to", async () => {
      prisma.bug.findUnique.mockResolvedValue(makeBug({ status: "OPEN" }));
      prisma.bug.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...makeBug(), ...data }),
      );

      await service.update("roki", "bug-1", { status: "CLAIMED" });

      expect(audit.record).toHaveBeenCalledWith(
        "roki",
        "bugs.bug.updated",
        "bug-1",
        expect.objectContaining({ status: { from: "OPEN", to: "CLAIMED" } }),
      );
    });
  });

  // ─── addComment ───────────────────────────────────────────────────────

  describe("addComment", () => {
    it("404s when the bug does not exist", async () => {
      prisma.bug.findUnique.mockResolvedValue(null);

      await expect(service.addComment(ADMIN, "missing", { body: "hi" })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("uses the admin's email as author when none is supplied", async () => {
      prisma.bug.findUnique.mockResolvedValue({ id: "bug-1", reporter: "anyone@example.com" });
      prisma.bugComment.create.mockResolvedValue({ id: "c-1", bugId: "bug-1" });

      await service.addComment(ADMIN, "bug-1", { body: "noted" });

      const call = prisma.bugComment.create.mock.calls[0][0];
      expect(call.data.author).toBe(ADMIN.email);
      expect(call.data.body).toBe("noted");
    });

    it("respects an admin's author override (e.g. claude:tab-2)", async () => {
      prisma.bug.findUnique.mockResolvedValue({ id: "bug-1", reporter: "anyone@example.com" });
      prisma.bugComment.create.mockResolvedValue({ id: "c-1", bugId: "bug-1" });

      await service.addComment(ADMIN, "bug-1", { author: "claude:tab-2", body: "fixing" });

      expect(prisma.bugComment.create.mock.calls[0][0].data.author).toBe("claude:tab-2");
    });

    it("ignores a tester's attempt to override author (forces tester email)", async () => {
      prisma.bug.findUnique.mockResolvedValue({ id: "bug-1", reporter: TESTER.email });
      prisma.bugComment.create.mockResolvedValue({ id: "c-1", bugId: "bug-1" });

      await service.addComment(TESTER, "bug-1", { author: "claude:tab-2", body: "hi" });

      expect(prisma.bugComment.create.mock.calls[0][0].data.author).toBe(TESTER.email);
    });

    it("403s when a tester comments on another reporter's bug", async () => {
      prisma.bug.findUnique.mockResolvedValue({ id: "bug-1", reporter: "other@example.com" });

      await expect(service.addComment(TESTER, "bug-1", { body: "nope" })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.bugComment.create).not.toHaveBeenCalled();
    });

    it("allows a tester to comment on their own bug", async () => {
      prisma.bug.findUnique.mockResolvedValue({ id: "bug-1", reporter: TESTER.email });
      prisma.bugComment.create.mockResolvedValue({ id: "c-2", bugId: "bug-1" });

      await expect(service.addComment(TESTER, "bug-1", { body: "still broken" })).resolves.toEqual({
        id: "c-2",
        bugId: "bug-1",
      });
    });

    it("audits the comment with the new comment id under the actor's email", async () => {
      prisma.bug.findUnique.mockResolvedValue({ id: "bug-1", reporter: ADMIN.email });
      prisma.bugComment.create.mockResolvedValue({ id: "c-7", bugId: "bug-1" });

      await service.addComment(ADMIN, "bug-1", { body: "hi" });

      expect(audit.record).toHaveBeenCalledWith(ADMIN.email, "bugs.bug.commented", "bug-1", {
        commentId: "c-7",
      });
    });
  });

  // ─── verifyFix ────────────────────────────────────────────────────────

  describe("verifyFix", () => {
    it("404s when the bug doesn't exist", async () => {
      prisma.bug.findUnique.mockResolvedValue(null);
      await expect(service.verifyFix(ADMIN, "missing")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("masks foreign bugs as 404 for testers", async () => {
      prisma.bug.findUnique.mockResolvedValue({
        id: "bug-1",
        status: "FIXED",
        reporter: "someone-else@example.com",
        verifiedAt: null,
        verifiedBy: null,
      });

      await expect(service.verifyFix(TESTER, "bug-1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.bug.update).not.toHaveBeenCalled();
    });

    it("rejects when the current status isn't FIXED", async () => {
      prisma.bug.findUnique.mockResolvedValue({
        id: "bug-1",
        status: "OPEN",
        reporter: TESTER.email,
        verifiedAt: null,
        verifiedBy: null,
      });

      await expect(service.verifyFix(TESTER, "bug-1")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.bug.update).not.toHaveBeenCalled();
    });

    it("flips FIXED → VERIFIED and stamps verifiedBy + verifiedAt for the reporter", async () => {
      prisma.bug.findUnique.mockResolvedValueOnce({
        id: "bug-1",
        status: "FIXED",
        reporter: TESTER.email,
        verifiedAt: null,
        verifiedBy: null,
      });
      prisma.bug.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: "bug-1", ...data }),
      );

      const result = await service.verifyFix(TESTER, "bug-1");

      const call = prisma.bug.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: "bug-1" });
      expect(call.data.status).toBe("VERIFIED");
      expect(call.data.verifiedBy).toBe(TESTER.email);
      expect(call.data.verifiedAt).toBeInstanceOf(Date);
      expect(audit.record).toHaveBeenCalledWith(
        TESTER.email,
        "bugs.bug.verified",
        "bug-1",
        { from: "FIXED", to: "VERIFIED" },
      );
      expect(result).toBeDefined();
    });

    it("admins may verify bugs they didn't report", async () => {
      prisma.bug.findUnique.mockResolvedValueOnce({
        id: "bug-1",
        status: "FIXED",
        reporter: "tester@example.com",
        verifiedAt: null,
        verifiedBy: null,
      });
      prisma.bug.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: "bug-1", ...data }),
      );

      await expect(service.verifyFix(ADMIN, "bug-1")).resolves.toBeDefined();
      expect(prisma.bug.update).toHaveBeenCalled();
    });

    it("is idempotent on already-VERIFIED bugs (no DB write, no audit)", async () => {
      const already = {
        id: "bug-1",
        status: "VERIFIED",
        reporter: TESTER.email,
        verifiedAt: new Date("2026-05-04T12:00:00Z"),
        verifiedBy: TESTER.email,
      };
      // first findUnique = the precheck; second = the include-rich return
      prisma.bug.findUnique
        .mockResolvedValueOnce(already)
        .mockResolvedValueOnce(already);

      await service.verifyFix(TESTER, "bug-1");

      expect(prisma.bug.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
