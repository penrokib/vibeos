/**
 * mesh.e2e-spec.ts — supertest-driven happy-path + hardwall regression
 * suite for M03 (rokibrain-app v1 design §2 + §16).
 *
 * Scope:
 *   1. schema validation rejection (bad DTO → 400)
 *   2. draft approve flow end-to-end: queue → approve → action_log row
 *   3. 429 returned when minute-bucket counter is at cap
 *   4. WS event emitted on draft approval (mesh.draft.approved)
 *
 * No real DB: PrismaService and AuthGuards are overridden with stubs so the
 * suite runs in any environment (CI, M3, M1) without touching Postgres.
 */
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { JwtAuthGuard } from "@vibeos/auth";
import { PrismaModule, PrismaService } from "@vibeos/database";
import request from "supertest";
import { AuditService } from "../src/audit/audit.service";
import { MeshGateway } from "../src/mesh/mesh.gateway";
import { MeshModule } from "../src/mesh/mesh.module";

class StubAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: "roki", email: "roki@dewx.com", role: "admin" };
    return true;
  }
}

const ACCT = {
  id: "11111111-1111-1111-1111-111111111111",
  ownerEmail: "roki@dewx.com",
  platform: "whatsapp",
  externalId: "+60123456789",
  label: "MY-personal",
  status: "connected",
  frozenUntil: null as Date | null,
  countryCc: "MY",
  pairedAt: new Date(),
  lastActiveAt: null,
  deviceId: "22222222-2222-2222-2222-222222222222",
  policyJson: {},
  blackoutWindows: [],
  createdAt: new Date(),
};

interface PrismaStub {
  meshAccount: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
  };
  meshMessage: { findMany: jest.Mock };
  meshContact: { findMany: jest.Mock };
  meshCounter: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
  meshDraft: {
    create: jest.Mock;
    update: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  meshActionLog: { create: jest.Mock; findMany?: jest.Mock };
  deviceAppInstall: { findUnique: jest.Mock };
  $transaction: jest.Mock;
}

function makePrismaStub(): PrismaStub {
  const stub: PrismaStub = {
    meshAccount: {
      findFirst: jest.fn().mockResolvedValue(ACCT),
      findUnique: jest.fn().mockResolvedValue(ACCT),
      update: jest.fn().mockResolvedValue(ACCT),
      create: jest.fn().mockResolvedValue(ACCT),
      count: jest.fn().mockResolvedValue(0),
    },
    meshMessage: { findMany: jest.fn().mockResolvedValue([]) },
    meshContact: { findMany: jest.fn().mockResolvedValue([]) },
    meshCounter: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ count: 1 }),
    },
    meshDraft: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    meshActionLog: { create: jest.fn().mockResolvedValue({ id: "log1" }) },
    deviceAppInstall: { findUnique: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(stub)),
  };
  return stub;
}

describe("Mesh REST + WS (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaStub;
  let gatewaySpy: { emitDraftApproved: jest.Mock; emitDraftQueued: jest.Mock };

  beforeAll(async () => {
    prisma = makePrismaStub();
    gatewaySpy = {
      emitDraftApproved: jest.fn(),
      emitDraftQueued: jest.fn(),
    };

    process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-for-e2e-only";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        // PrismaModule is @Global — provides PrismaService; we override it
        // via overrideProvider() below so no real DB is touched.
        PrismaModule.forRoot(),
        // AuditModule + JwtModule come transitively through MeshModule.
        MeshModule,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(StubAuthGuard)
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AuditService)
      .useValue({ record: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(MeshGateway)
      .useValue({
        emitDraftApproved: gatewaySpy.emitDraftApproved,
        emitDraftQueued: gatewaySpy.emitDraftQueued,
        emitInbound: jest.fn(),
        emitCounterTripped: jest.fn(),
        emitAccountStatus: jest.fn(),
        clientCount: () => 0,
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. schema validation
  // ────────────────────────────────────────────────────────────────────

  it("POST /mesh/whatsapp/draft rejects missing body with 400", async () => {
    await request(app.getHttpServer())
      .post("/mesh/whatsapp/draft")
      .send({ account: "+60123456789", to: "62888" }) // body missing
      .expect(400);
  });

  it("POST /mesh/:platform/draft rejects unknown platform with 400", async () => {
    await request(app.getHttpServer())
      .post("/mesh/myspace/draft")
      .send({ account: "+60123456789", to: "62888", body: "hi" })
      .expect(400);
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. queue → approve → action_log
  // ────────────────────────────────────────────────────────────────────

  it("draft approval flow end-to-end: queue → approve → action_log row", async () => {
    prisma.meshAccount.findFirst.mockResolvedValue(ACCT);
    prisma.meshDraft.create.mockResolvedValue({
      id: "33333333-3333-3333-3333-333333333333",
      accountId: ACCT.id,
      contactExternalId: "62888",
      body: "hi",
      approvedAt: null,
      rejectedAt: null,
    });
    prisma.meshActionLog.create.mockResolvedValue({ id: "log1" });

    // queue
    const queued = await request(app.getHttpServer())
      .post("/mesh/whatsapp/draft")
      .send({ account: "+60123456789", to: "62888", body: "hi" })
      .expect(201);
    expect(queued.body.id).toBeTruthy();
    expect(gatewaySpy.emitDraftQueued).toHaveBeenCalled();

    // approve
    prisma.meshDraft.findUnique.mockResolvedValue({
      id: queued.body.id,
      accountId: ACCT.id,
      approvedAt: null,
      rejectedAt: null,
    });
    prisma.meshDraft.update.mockResolvedValue({
      id: queued.body.id,
      accountId: ACCT.id,
      approvedAt: new Date(),
      approvedBy: "roki@dewx.com",
    });

    const approved = await request(app.getHttpServer())
      .post(`/mesh/draft/${queued.body.id}/approve`)
      .send({ approverEmail: "roki@dewx.com" })
      .expect(201);
    expect(approved.body.approvedBy).toBe("roki@dewx.com");

    // action_log row written for both queue + approve
    const actions = prisma.meshActionLog.create.mock.calls.map(
      (c: any) => c[0].data.action,
    );
    expect(actions).toContain("draft.queued");
    expect(actions).toContain("draft.approve");

    // WS gateway fan-out fired
    expect(gatewaySpy.emitDraftApproved).toHaveBeenCalled();
  });

  it("approve rejects when approverEmail missing (§10 hardwall #14)", async () => {
    await request(app.getHttpServer())
      .post(`/mesh/draft/${ACCT.id}/approve`)
      .send({})
      .expect(400);
  });

  // ────────────────────────────────────────────────────────────────────
  // 3. 429 anti-ban refusal
  // ────────────────────────────────────────────────────────────────────

  it("returns 429 anti_ban_refusal when minute-bucket already at cap", async () => {
    prisma.meshAccount.findFirst.mockResolvedValue(ACCT);
    // Simulate peek finding minute=8 (== cap).
    prisma.meshCounter.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.accountId_bucket_bucketStart.bucket === "minute"
          ? { count: 8 }
          : null,
      ),
    );

    const res = await request(app.getHttpServer())
      .post("/mesh/whatsapp/draft")
      .send({ account: "+60123456789", to: "62888", body: "hi" })
      .expect(429);
    expect(res.body.error).toBe("anti_ban_refusal");
    expect(res.body.until_iso).toBeTruthy();
    expect(res.body.reason).toMatch(/minute_cap_exceeded/);

    // reset
    prisma.meshCounter.findUnique.mockResolvedValue(null);
  });

  // ────────────────────────────────────────────────────────────────────
  // 4. health + counters + listing
  // ────────────────────────────────────────────────────────────────────

  it("GET /mesh/health returns ok envelope", async () => {
    prisma.meshAccount.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);
    const res = await request(app.getHttpServer())
      .get("/mesh/health")
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accounts).toEqual({ total: 3, frozen: 0, banned: 0, connected: 2 });
  });

  it("GET /mesh/whatsapp/inbox?account=+60... validates query DTO", async () => {
    prisma.meshAccount.findFirst.mockResolvedValue(ACCT);
    prisma.meshMessage.findMany.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/mesh/whatsapp/inbox?account=${encodeURIComponent("+60123456789")}&limit=10`)
      .expect(200);
    // missing account → 400
    await request(app.getHttpServer()).get("/mesh/whatsapp/inbox").expect(400);
  });

  it("GET /mesh/counters returns array", async () => {
    prisma.meshAccount.findFirst.mockResolvedValue(ACCT);
    prisma.meshCounter.findMany.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/mesh/counters?account=${encodeURIComponent("+60123456789")}`)
      .expect(200);
  });
});
