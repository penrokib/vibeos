import { createHash } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { AuthService } from "./auth.service";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("AuthService", () => {
  let service: AuthService;
  let config: { get: jest.Mock };
  let jwt: { sign: jest.Mock };

  beforeEach(async () => {
    config = { get: jest.fn() };
    jwt = { sign: jest.fn().mockReturnValue("signed.jwt.token") };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: ConfigService, useValue: config },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe("validate (admin)", () => {
    it("authenticates the configured admin with the right password", async () => {
      const password = "hunter2";
      config.get.mockImplementation((key: string) => {
        if (key === "ADMIN_EMAIL") return "Roki@Example.com";
        if (key === "ADMIN_PASSWORD_SHA256") return sha256(password + "pep");
        if (key === "AUTH_PEPPER") return "pep";
        return undefined;
      });

      const payload = await service.validate("roki@example.com", password);
      expect(payload).toEqual({
        sub: "roki@example.com",
        email: "roki@example.com",
        role: "admin",
        tenantId: "roki",
      });
    });

    it("rejects the admin with the wrong password", async () => {
      config.get.mockImplementation((key: string) => {
        if (key === "ADMIN_EMAIL") return "roki@example.com";
        if (key === "ADMIN_PASSWORD_SHA256") return sha256("right-pw");
        return undefined;
      });

      await expect(service.validate("roki@example.com", "wrong-pw")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("rejects an unknown email", async () => {
      config.get.mockReturnValue(undefined);
      await expect(service.validate("nobody@example.com", "x")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe("validate (tester)", () => {
    it("authenticates a tester from TESTER_USERS_JSON", async () => {
      const password = "openplease";
      config.get.mockImplementation((key: string) => {
        if (key === "TESTER_USERS_JSON")
          return JSON.stringify([{ email: "Tester@x.com", passwordSha256: sha256(password) }]);
        return undefined;
      });

      const payload = await service.validate("tester@x.com", password);
      expect(payload).toEqual({
        sub: "tester@x.com",
        email: "tester@x.com",
        role: "tester",
        tenantId: "roki",
      });
    });

    it("ignores malformed TESTER_USERS_JSON instead of crashing", async () => {
      config.get.mockImplementation((key: string) =>
        key === "TESTER_USERS_JSON" ? "{not-json" : undefined,
      );

      await expect(service.validate("anyone@x.com", "pw")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe("signToken", () => {
    it("signs the payload with the configured TTL", () => {
      config.get.mockImplementation((key: string) =>
        key === "AUTH_TOKEN_TTL" ? "12h" : undefined,
      );

      const token = service.signToken({
        sub: "roki",
        email: "r@x.com",
        role: "admin",
        tenantId: "roki",
      });

      expect(token).toBe("signed.jwt.token");
      expect(jwt.sign).toHaveBeenCalledWith(
        { sub: "roki", email: "r@x.com", role: "admin", tenantId: "roki" },
        { expiresIn: "12h" },
      );
    });
  });

  describe("cookieMaxAgeSeconds", () => {
    it("parses days/hours/minutes/seconds", () => {
      config.get.mockImplementation((key: string) =>
        key === "AUTH_TOKEN_TTL" ? "7d" : undefined,
      );
      expect(service.cookieMaxAgeSeconds()).toBe(604800);

      config.get.mockImplementation((key: string) =>
        key === "AUTH_TOKEN_TTL" ? "12h" : undefined,
      );
      expect(service.cookieMaxAgeSeconds()).toBe(43200);

      config.get.mockImplementation((key: string) =>
        key === "AUTH_TOKEN_TTL" ? "30m" : undefined,
      );
      expect(service.cookieMaxAgeSeconds()).toBe(1800);

      config.get.mockImplementation((key: string) =>
        key === "AUTH_TOKEN_TTL" ? "45" : undefined,
      );
      expect(service.cookieMaxAgeSeconds()).toBe(45);
    });

    it("falls back to 7d when TTL is missing or unparseable", () => {
      config.get.mockReturnValue(undefined);
      expect(service.cookieMaxAgeSeconds()).toBe(604800);

      config.get.mockReturnValue("not-a-duration");
      expect(service.cookieMaxAgeSeconds()).toBe(604800);
    });
  });
});
