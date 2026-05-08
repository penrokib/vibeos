// =============================================================================
// ComposeController — unit tests (Cycle 18)
// =============================================================================

// Mock @vibeos/auth before any imports to avoid module resolution failures
// in the Jest environment (workspace packages not built — no dist/ dir).
// virtual:true creates the mock without needing the module to exist on disk.
jest.mock("@vibeos/auth", () => ({
  JwtAuthGuard: class MockJwtAuthGuard {
    canActivate() { return true; }
  },
  RolesGuard: class MockRolesGuard {
    canActivate() { return true; }
  },
  CurrentUser: () => (target: unknown, key: string, idx: number) => { void target; void key; void idx; },
  Roles: (..._roles: string[]) => () => undefined,
}), { virtual: true });

import { Test, type TestingModule } from "@nestjs/testing";
import { HttpException } from "@nestjs/common";
import { ComposeController } from "../compose.controller";
import { ComposeService } from "../compose.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockUser = (tenantId = "tenant-abc") => ({
  sub: "user-1",
  email: "roki@test.com",
  tenantId,
  role: "admin",
  iat: 0,
  exp: 9999999999,
});

function makeComposeService(
  overrides: Partial<{
    createTextRequest: jest.Mock;
    createVoiceRequest: jest.Mock;
    getRequest: jest.Mock;
    resolveRequest: jest.Mock;
    errorRequest: jest.Mock;
  }> = {},
) {
  return {
    createTextRequest: overrides.createTextRequest ?? jest.fn().mockReturnValue({ requestId: "req-001" }),
    createVoiceRequest: overrides.createVoiceRequest ?? jest.fn().mockReturnValue({ requestId: "req-002" }),
    getRequest: overrides.getRequest ?? jest.fn().mockReturnValue(null),
    resolveRequest: overrides.resolveRequest ?? jest.fn().mockReturnValue(true),
    errorRequest: overrides.errorRequest ?? jest.fn().mockReturnValue(true),
  };
}

async function buildModule(
  svc: ReturnType<typeof makeComposeService>,
): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [ComposeController],
    providers: [
      { provide: ComposeService, useValue: svc },
    ],
  }).compile();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ComposeController", () => {
  // ── POST /compose/text routes to Mac via WS ────────────────────────────────

  it("POST /compose/text — routes compose-request to user's Mac via ComposeService", async () => {
    const mockCreate = jest.fn().mockReturnValue({ requestId: "req-text-001" });
    const svc = makeComposeService({ createTextRequest: mockCreate });
    const module = await buildModule(svc);
    const ctrl = module.get<ComposeController>(ComposeController);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = ctrl.composeText(mockUser() as any, {
      account: "wap",
      recipient: "+601234567890",
      persona: "ceo",
      rawText: "Hey, quick catch-up this week?",
      mode: "work",
    });

    expect(result.requestId).toBe("req-text-001");
    expect(result.status).toBe("pending");
    // ComposeService.createTextRequest was called with tenant from JWT
    expect(mockCreate).toHaveBeenCalledWith(
      "tenant-abc",
      expect.objectContaining({ rawText: "Hey, quick catch-up this week?" }),
    );
  });

  // ── Tenant isolation — tenant A cannot access tenant B's request ───────────

  it("tenant isolation — GET /compose/:id returns 404 for wrong tenant", async () => {
    const getReq = jest.fn().mockReturnValue(null); // null = not found or wrong tenant
    const svc = makeComposeService({ getRequest: getReq });
    const module = await buildModule(svc);
    const ctrl = module.get<ComposeController>(ComposeController);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => ctrl.getResult(mockUser("tenant-B") as any, "req-owned-by-A")).toThrow(HttpException);

    // ComposeService was called with tenant B's tenantId
    expect(getReq).toHaveBeenCalledWith("req-owned-by-A", "tenant-B");
  });

  // ── Mac offline — 404 when requestId not found ────────────────────────────

  it("GET /compose/:id returns 404 when Mac is offline / request expired", async () => {
    const svc = makeComposeService({ getRequest: jest.fn().mockReturnValue(null) });
    const module = await buildModule(svc);
    const ctrl = module.get<ComposeController>(ComposeController);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => ctrl.getResult(mockUser() as any, "nonexistent-id")).toThrow(HttpException);
  });

  // ── Polling returns status ─────────────────────────────────────────────────

  it("GET /compose/:id returns pending status while Mac is processing", async () => {
    const svc = makeComposeService({
      getRequest: jest.fn().mockReturnValue({
        requestId: "req-999",
        tenantId: "tenant-abc",
        status: "pending",
        account: "wap",
        recipient: "+1",
        persona: "ceo",
        mode: "work",
        createdAt: new Date().toISOString(),
      }),
    });
    const module = await buildModule(svc);
    const ctrl = module.get<ComposeController>(ComposeController);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = ctrl.getResult(mockUser() as any, "req-999");
    expect(result.status).toBe("pending");
    expect(result.draftId).toBeUndefined();
  });

  it("GET /compose/:id returns done with draftId when completed", async () => {
    const svc = makeComposeService({
      getRequest: jest.fn().mockReturnValue({
        requestId: "req-done",
        tenantId: "tenant-abc",
        status: "done",
        result: { draftId: "d-123", refinedText: "Polished text", reasoning: "Shortened" },
        account: "wap",
        recipient: "+1",
        persona: "ceo",
        mode: "work",
        createdAt: new Date().toISOString(),
      }),
    });
    const module = await buildModule(svc);
    const ctrl = module.get<ComposeController>(ComposeController);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = ctrl.getResult(mockUser() as any, "req-done");
    expect(result.status).toBe("done");
    expect(result.draftId).toBe("d-123");
    expect(result.refinedText).toBe("Polished text");
  });
});
