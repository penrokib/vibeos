import { Test } from "@nestjs/testing";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "./audit.service";

describe("AuditService", () => {
  let service: AuditService;
  let prisma: {
    auditEvent: jest.Mocked<{ create: jest.Mock; findMany: jest.Mock }>;
  };

  beforeEach(async () => {
    prisma = {
      auditEvent: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      } as never,
    };

    const moduleRef = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(AuditService);
  });

  it("record() writes one row with actor/action/target/payload", async () => {
    await service.record("roki", "decision.approved", "d1", { from: "pending" });

    expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    const call = prisma.auditEvent.create.mock.calls[0][0];
    expect(call.data.actor).toBe("roki");
    expect(call.data.action).toBe("decision.approved");
    expect(call.data.target).toBe("d1");
    expect(call.data.payload).toEqual({ from: "pending" });
  });

  it("record() defaults target to null and payload to undefined when omitted", async () => {
    await service.record("roki", "decision.viewed");

    const call = prisma.auditEvent.create.mock.calls[0][0];
    expect(call.data.target).toBeNull();
    expect(call.data.payload).toBeUndefined();
  });

  it("record() swallows errors so the caller's mutation isn't rolled back", async () => {
    prisma.auditEvent.create.mockRejectedValueOnce(new Error("db down"));
    // The service logs the failure — silence that one line so test output stays clean.
    const logSpy = jest
      .spyOn(service["logger"], "error" as never)
      .mockImplementation(() => undefined);

    await expect(service.record("roki", "decision.approved", "d1")).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("list() caps at 500 even if a higher limit is requested", () => {
    service.list(9999);

    const call = prisma.auditEvent.findMany.mock.calls[0][0];
    expect(call.take).toBe(500);
    expect(call.orderBy).toEqual({ createdAt: "desc" });
  });

  it("list() defaults to 100 rows when no limit is passed", () => {
    service.list();

    const call = prisma.auditEvent.findMany.mock.calls[0][0];
    expect(call.take).toBe(100);
  });
});
