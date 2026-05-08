import { UnauthorizedException } from "@nestjs/common";
import { TenantContextService } from "./tenant-context.service";

describe("TenantContextService", () => {
  it("returns tenantId from req.user when populated", () => {
    const svc = new TenantContextService({
      user: { sub: "u1", email: "a@b", role: "admin", tenantId: "tenant-abc" },
    });
    expect(svc.tenantId).toBe("tenant-abc");
    expect(svc.userId).toBe("u1");
  });

  it("throws when req.user is missing", () => {
    const svc = new TenantContextService({});
    expect(() => svc.tenantId).toThrow(UnauthorizedException);
    expect(() => svc.userId).toThrow(UnauthorizedException);
  });

  it("throws when tenantId is missing on user", () => {
    const svc = new TenantContextService({
      user: { sub: "u1", email: "a@b", role: "admin", tenantId: "" },
    });
    expect(() => svc.tenantId).toThrow(UnauthorizedException);
  });

  it("simulates 5 parallel requests with different tenants — no cross-contamination", () => {
    const services = ["t-1", "t-2", "t-3", "t-4", "t-5"].map(
      (id) =>
        new TenantContextService({
          user: { sub: `u-${id}`, email: `${id}@x`, role: "admin", tenantId: id },
        }),
    );
    const ids = services.map((s) => s.tenantId);
    expect(ids).toEqual(["t-1", "t-2", "t-3", "t-4", "t-5"]);
    // Each instance is independent — no shared mutable state.
    expect(new Set(ids).size).toBe(5);
  });
});
