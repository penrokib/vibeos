import "reflect-metadata";
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtAuthGuard } from "./jwt-auth.guard";

function fakeContext(): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({}),
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe("JwtAuthGuard", () => {
  it("bypasses authentication when @Public() metadata is set", async () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(true);
    const guard = new JwtAuthGuard(reflector);

    await expect(guard.canActivate(fakeContext())).resolves.toBe(true);
  });

  it("handleRequest throws UnauthorizedException when info is TokenExpiredError", () => {
    const guard = new JwtAuthGuard(new Reflector());
    const info = Object.assign(new Error("jwt expired"), {
      name: "TokenExpiredError",
    });
    expect(() => guard.handleRequest(null, null, info)).toThrow(UnauthorizedException);
    expect(() => guard.handleRequest(null, null, info)).toThrow("Token has expired");
  });

  it("handleRequest throws UnauthorizedException when info is JsonWebTokenError", () => {
    const guard = new JwtAuthGuard(new Reflector());
    const info = Object.assign(new Error("invalid signature"), {
      name: "JsonWebTokenError",
    });
    expect(() => guard.handleRequest(null, null, info)).toThrow(/JWT Error: invalid signature/);
  });

  it("handleRequest returns the user when one is provided", () => {
    const guard = new JwtAuthGuard(new Reflector());
    const user = { sub: "roki", email: "hello@rokibrain.com" };
    expect(guard.handleRequest(null, user, null)).toBe(user);
  });

  it("handleRequest throws when no user and no info", () => {
    const guard = new JwtAuthGuard(new Reflector());
    expect(() => guard.handleRequest(null, null, null)).toThrow(UnauthorizedException);
  });
});
