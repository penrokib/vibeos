import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import type { JwtPayload, UserRole } from "../types";
import { RolesGuard } from "./roles.guard";

const mkContext = (user: JwtPayload | undefined): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined as unknown,
    getClass: () => undefined as unknown,
  }) as unknown as ExecutionContext;

const mkReflector = (required: UserRole[] | undefined) =>
  ({
    getAllAndOverride: jest.fn().mockImplementation((key: string) =>
      key === ROLES_KEY ? required : undefined,
    ),
  }) as unknown as Reflector;

describe("RolesGuard", () => {
  it("allows the request when no @Roles() metadata is present", () => {
    const guard = new RolesGuard(mkReflector(undefined));
    expect(
      guard.canActivate(mkContext({ sub: "1", email: "x@example.com", role: "tester" })),
    ).toBe(true);
  });

  it("allows the request when @Roles() is empty", () => {
    const guard = new RolesGuard(mkReflector([]));
    expect(
      guard.canActivate(mkContext({ sub: "1", email: "x@example.com", role: "tester" })),
    ).toBe(true);
  });

  it("throws Unauthorized when there's no user on the request", () => {
    const guard = new RolesGuard(mkReflector(["admin"]));
    expect(() => guard.canActivate(mkContext(undefined))).toThrow(UnauthorizedException);
  });

  it("throws Forbidden when the user's role is not in the required list", () => {
    const guard = new RolesGuard(mkReflector(["admin"]));
    expect(() =>
      guard.canActivate(mkContext({ sub: "1", email: "t@example.com", role: "tester" })),
    ).toThrow(ForbiddenException);
  });

  it("allows when the user's role matches one of the required roles", () => {
    const guard = new RolesGuard(mkReflector(["admin", "tester"]));
    expect(
      guard.canActivate(mkContext({ sub: "1", email: "t@example.com", role: "tester" })),
    ).toBe(true);
  });
});
