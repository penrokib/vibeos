import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";
import { DecisionsService } from "./decisions.service";

type DecisionRow = {
  id: string;
  title: string;
  body: string;
  status: string;
  source: string | null;
  createdAt: Date;
  decidedAt: Date | null;
};

const makeDecision = (overrides: Partial<DecisionRow> = {}): DecisionRow => ({
  id: "d1",
  title: "Test",
  body: "body",
  status: "pending",
  source: null,
  createdAt: new Date("2026-05-03T00:00:00Z"),
  decidedAt: null,
  ...overrides,
});

describe("DecisionsService", () => {
  let service: DecisionsService;
  let prisma: {
    decision: jest.Mocked<{
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      groupBy: jest.Mock;
    }>;
  };
  let audit: jest.Mocked<Pick<AuditService, "record">>;

  beforeEach(async () => {
    prisma = {
      decision: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        groupBy: jest.fn(),
      } as never,
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DecisionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(DecisionsService);
  });

  it("list() returns at most 100 rows ordered desc by createdAt", () => {
    const rows = [makeDecision()];
    prisma.decision.findMany.mockReturnValue(rows);

    const result = service.list("roki");

    expect(prisma.decision.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    expect(result).toBe(rows);
  });

  it("list() applies the status filter when supplied", () => {
    prisma.decision.findMany.mockReturnValue([]);

    service.list("roki", { status: "pending" });

    expect(prisma.decision.findMany).toHaveBeenCalledWith({
      where: { status: "pending" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  it("list() honours the take override", () => {
    prisma.decision.findMany.mockReturnValue([]);

    service.list("roki", { take: 5 });

    expect(prisma.decision.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { createdAt: "desc" },
      take: 5,
    });
  });

  it("list() caps take at 500 even if a larger value sneaks past validation", () => {
    prisma.decision.findMany.mockReturnValue([]);

    service.list("roki", { take: 9999 });

    expect(prisma.decision.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  });

  it("stats() returns zero-filled counts for every known status", async () => {
    prisma.decision.groupBy.mockResolvedValue([
      { status: "pending", _count: { _all: 7 } },
      { status: "approved", _count: { _all: 3 } },
    ]);

    const result = await service.stats("roki");

    expect(prisma.decision.groupBy).toHaveBeenCalledWith({
      by: ["status"],
      _count: { _all: true },
    });
    expect(result).toEqual({ pending: 7, approved: 3, skipped: 0, deferred: 0 });
  });

  it("stats() ignores unknown statuses already in the database", async () => {
    prisma.decision.groupBy.mockResolvedValue([
      { status: "pending", _count: { _all: 2 } },
      { status: "legacy-status", _count: { _all: 99 } },
    ]);

    const result = await service.stats("roki");

    expect(result).toEqual({ pending: 2, approved: 0, skipped: 0, deferred: 0 });
  });

  it("get() raises 404 when missing", async () => {
    prisma.decision.findUnique.mockResolvedValue(null);

    await expect(service.get("roki", "missing")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("get() returns the row when present", async () => {
    const row = makeDecision({ id: "abc" });
    prisma.decision.findUnique.mockResolvedValue(row);

    await expect(service.get("roki", "abc")).resolves.toBe(row);
  });

  it("update() to non-pending sets decidedAt to a Date", async () => {
    prisma.decision.findUnique.mockResolvedValue(makeDecision({ id: "x" }));
    prisma.decision.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...makeDecision({ id: "x" }), ...data }),
    );

    const result = await service.update("roki", "x", { status: "approved" });

    expect(prisma.decision.update).toHaveBeenCalledTimes(1);
    const call = prisma.decision.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "x" });
    expect(call.data.status).toBe("approved");
    expect(call.data.decidedAt).toBeInstanceOf(Date);
    expect(result.status).toBe("approved");
  });

  it("update() back to pending clears decidedAt", async () => {
    prisma.decision.findUnique.mockResolvedValue(
      makeDecision({ id: "x", status: "approved", decidedAt: new Date() }),
    );
    prisma.decision.update.mockResolvedValue(makeDecision({ id: "x" }));

    await service.update("roki", "x", { status: "pending" });

    const call = prisma.decision.update.mock.calls[0][0];
    expect(call.data.decidedAt).toBeNull();
  });

  it("update() writes one audit row capturing from/to status transition", async () => {
    prisma.decision.findUnique.mockResolvedValue(makeDecision({ id: "x", status: "pending" }));
    prisma.decision.update.mockResolvedValue(makeDecision({ id: "x", status: "approved" }));

    await service.update("roki", "x", { status: "approved" });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith("roki", "decision.approved", "x", {
      from: "pending",
      to: "approved",
    });
  });

  it("update() does not audit when get() raises 404", async () => {
    prisma.decision.findUnique.mockResolvedValue(null);

    await expect(service.update("roki", "missing", { status: "approved" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
    expect(prisma.decision.update).not.toHaveBeenCalled();
  });
});
