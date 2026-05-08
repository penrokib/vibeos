import { BadRequestException, ForbiddenException, HttpStatus } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";
import { AntiBanRefusalException, MeshService } from "./mesh.service";

/**
 * Bug-prevention pyramid (Class A/B/C):
 *  - A: tenant-scoped queries — every account read goes through resolveAccount.
 *  - B: anti-ban refusal envelope contract is locked — desktop daemon parses
 *       error: "anti_ban_refusal" + reason + until_iso + counters.
 *  - C: explicit approverEmail required for every approve call.
 *
 * No DB access — Prisma is mocked. e2e wiring lives in test/mesh.e2e-spec.ts.
 */

interface AcctRow {
  id: string;
  ownerEmail: string;
  platform: string;
  externalId: string | null;
  label: string;
  status: string;
  frozenUntil: Date | null;
  countryCc: string | null;
  pairedAt: Date | null;
  lastActiveAt: Date | null;
  deviceId: string;
  policyJson: object;
  blackoutWindows: unknown[];
  createdAt: Date;
}

const makeAcct = (over: Partial<AcctRow> = {}): AcctRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  ownerEmail: "roki@dewx.com",
  platform: "whatsapp",
  externalId: "+60123456789",
  label: "MY-personal",
  status: "connected",
  frozenUntil: null,
  countryCc: "MY",
  pairedAt: new Date(),
  lastActiveAt: null,
  deviceId: "22222222-2222-2222-2222-222222222222",
  policyJson: {},
  blackoutWindows: [],
  createdAt: new Date(),
  ...over,
});

describe("MeshService", () => {
  let service: MeshService;
  let prisma: any;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      meshAccount: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      meshMessage: { findMany: jest.fn().mockResolvedValue([]) },
      meshContact: { findMany: jest.fn().mockResolvedValue([]) },
      meshCounter: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      meshDraft: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      meshActionLog: { create: jest.fn().mockResolvedValue({ id: "log1" }) },
      deviceAppInstall: { findUnique: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeshService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(MeshService);
  });

  describe("createDraft — anti-ban hardwalls", () => {
    it("refuses when account is frozen with future frozenUntil", async () => {
      const future = new Date(Date.now() + 3_600_000);
      prisma.meshAccount.findFirst.mockResolvedValue(
        makeAcct({ status: "frozen", frozenUntil: future }),
      );

      await expect(
        service.createDraft("whatsapp", {
          account: "+60123456789",
          to: "62888",
          body: "hi",
        }),
      ).rejects.toBeInstanceOf(AntiBanRefusalException);
    });

    it("refuses banned accounts with 403", async () => {
      prisma.meshAccount.findFirst.mockResolvedValue(makeAcct({ status: "banned" }));
      await expect(
        service.createDraft("whatsapp", {
          account: "+60123456789",
          to: "62888",
          body: "hi",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses similarity_score >= 0.85", async () => {
      prisma.meshAccount.findFirst.mockResolvedValue(makeAcct());
      await expect(
        service.createDraft("whatsapp", {
          account: "+60123456789",
          to: "62888",
          body: "hi",
          similarityScore: 0.91,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses when minute counter already at cap (peek)", async () => {
      prisma.meshAccount.findFirst.mockResolvedValue(makeAcct());
      // Peek returns 8 for `minute` — equals cap → refuse.
      prisma.meshCounter.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.accountId_bucket_bucketStart.bucket === "minute"
            ? { count: 8 }
            : null,
        ),
      );

      await expect(
        service.createDraft("whatsapp", {
          account: "+60123456789",
          to: "62888",
          body: "hi",
        }),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    });

    it("happy-path: queues draft, logs draft.queued", async () => {
      prisma.meshAccount.findFirst.mockResolvedValue(makeAcct());
      prisma.meshDraft.create.mockResolvedValue({
        id: "drf1",
        accountId: "11111111-1111-1111-1111-111111111111",
        body: "hi",
      });

      const out = await service.createDraft("whatsapp", {
        account: "+60123456789",
        to: "62888",
        body: "hi",
      });

      expect(out.id).toBe("drf1");
      expect(prisma.meshDraft.create).toHaveBeenCalledTimes(1);
      expect(prisma.meshActionLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: "draft.queued" }),
        }),
      );
    });
  });

  describe("approveDraft", () => {
    it("requires approverEmail (§10 hardwall #14)", async () => {
      prisma.meshDraft.findUnique.mockResolvedValue({
        id: "drf1",
        accountId: "a1",
        approvedAt: null,
        rejectedAt: null,
      });
      // DTO normally guards this, but second wall in service:
      await expect(
        service.approveDraft("drf1", { approverEmail: "" }, "user1"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("404 on missing draft", async () => {
      prisma.meshDraft.findUnique.mockResolvedValue(null);
      await expect(
        service.approveDraft(
          "00000000-0000-0000-0000-000000000000",
          { approverEmail: "roki@dewx.com" },
          "user1",
        ),
      ).rejects.toThrow(/not found/);
    });

    it("happy-path: increments counters, marks approved, audit recorded", async () => {
      prisma.meshDraft.findUnique.mockResolvedValue({
        id: "drf1",
        accountId: "a1",
        approvedAt: null,
        rejectedAt: null,
      });
      prisma.meshCounter.upsert.mockImplementation(({ create }: any) =>
        Promise.resolve({ count: create.count }),
      );
      prisma.meshDraft.update.mockResolvedValue({
        id: "drf1",
        approvedAt: new Date(),
        approvedBy: "roki@dewx.com",
      });

      const out = await service.approveDraft(
        "drf1",
        { approverEmail: "roki@dewx.com" },
        "user1",
      );

      expect(out.approvedBy).toBe("roki@dewx.com");
      expect(prisma.meshCounter.upsert).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        "user1",
        "mesh.draft.approve",
        "drf1",
        expect.objectContaining({ approver: "roki@dewx.com" }),
      );
    });

    it("trips burst_60s → freezes account 10 min and throws 429", async () => {
      prisma.meshDraft.findUnique.mockResolvedValue({
        id: "drf2",
        accountId: "a1",
        approvedAt: null,
        rejectedAt: null,
      });
      // Simulate every prior bucket returns count 1 (under cap), but burst_60s
      // returns 6 (over cap=5) → trip.
      prisma.meshCounter.upsert.mockImplementation(({ where }: any) => {
        if (where.accountId_bucket_bucketStart.bucket === "burst_60s")
          return Promise.resolve({ count: 6 });
        return Promise.resolve({ count: 1 });
      });

      await expect(
        service.approveDraft("drf2", { approverEmail: "roki@dewx.com" }, "u"),
      ).rejects.toBeInstanceOf(AntiBanRefusalException);

      expect(prisma.meshAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "a1" },
          data: expect.objectContaining({ status: "frozen" }),
        }),
      );
    });
  });

  describe("rejectDraft", () => {
    it("rejects + audits", async () => {
      prisma.meshDraft.findUnique.mockResolvedValue({
        id: "drf3",
        accountId: "a1",
        approvedAt: null,
        rejectedAt: null,
      });
      prisma.meshDraft.update.mockResolvedValue({ id: "drf3", rejectedAt: new Date() });

      await service.rejectDraft("drf3", { rejectorEmail: "roki@dewx.com" }, "u");

      expect(audit.record).toHaveBeenCalledWith(
        "u",
        "mesh.draft.reject",
        "drf3",
        expect.any(Object),
      );
    });

    it("refuses double-rejection", async () => {
      prisma.meshDraft.findUnique.mockResolvedValue({
        id: "drf3",
        accountId: "a1",
        approvedAt: null,
        rejectedAt: new Date(),
      });
      await expect(
        service.rejectDraft("drf3", { rejectorEmail: "roki@dewx.com" }, "u"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("createAccount", () => {
    it("404 when device_app_install missing", async () => {
      prisma.deviceAppInstall.findUnique.mockResolvedValue(null);
      await expect(
        service.createAccount(
          {
            platform: "whatsapp",
            deviceId: "00000000-0000-0000-0000-000000000000",
            label: "x",
          },
          "roki@dewx.com",
        ),
      ).rejects.toThrow(/device_app_install/);
    });
  });

  describe("health", () => {
    it("returns aggregate counts", async () => {
      prisma.meshAccount.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(4);
      const h = await service.health();
      expect(h.ok).toBe(true);
      expect(h.accounts).toEqual({ total: 5, frozen: 1, banned: 0, connected: 4 });
    });
  });
});
