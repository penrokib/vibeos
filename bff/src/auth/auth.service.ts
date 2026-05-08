import { createHash, timingSafeEqual } from "node:crypto";
import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { JwtPayload, UserRole } from "@vibeos/auth";

interface KnownUser {
  email: string;
  role: UserRole;
  passwordHash: string;
  name?: string;
}

/**
 * AuthService — minimal credential check + JWT mint for the bugs.rokibrain.com
 * flow served at app.rokibrain.com.
 *
 * v1 storage model: env-configured users (no DB user table). Two channels:
 *   - ADMIN_EMAIL + ADMIN_PASSWORD_SHA256        → role=admin
 *   - TESTER_USERS_JSON: '[{"email":"...","passwordSha256":"...","name":"..."}]'
 *
 * Hashes are SHA-256 of `password + AUTH_PEPPER` (env). Internal-tool grade.
 * Swap to bcrypt/argon2 + DB-backed users when this graduates beyond Roki + a
 * handful of invited testers.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  async validate(email: string, password: string): Promise<JwtPayload> {
    const user = this.findUser(email);
    if (!user) throw new UnauthorizedException("invalid credentials");

    const expected = Buffer.from(user.passwordHash, "hex");
    const got = createHash("sha256").update(this.peppered(password)).digest();
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      throw new UnauthorizedException("invalid credentials");
    }

    // v1: legacy single-tenant rokibrain users land in the "roki" tenant.
    // OSS multi-tenant signups will populate this with a per-user UUID.
    return { sub: user.email, email: user.email, role: user.role, tenantId: "roki" };
  }

  signToken(payload: JwtPayload): string {
    const ttl = this.config.get<string>("AUTH_TOKEN_TTL") ?? "7d";
    // Cast: nest's JwtModule overloads conflict with our typed payload.
    return this.jwt.sign({ ...payload }, { expiresIn: ttl as unknown as number });
  }

  cookieMaxAgeSeconds(): number {
    const ttl = this.config.get<string>("AUTH_TOKEN_TTL") ?? "7d";
    // Accept "<n>d", "<n>h", "<n>m", "<n>s" or a raw seconds number.
    const m = /^(\d+)([dhms])?$/.exec(ttl);
    if (!m) return 7 * 24 * 60 * 60;
    const n = Number(m[1]);
    const unit = m[2] ?? "s";
    const mul = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
    return n * mul;
  }

  private peppered(password: string): string {
    return password + (this.config.get<string>("AUTH_PEPPER") ?? "");
  }

  private findUser(email: string): KnownUser | undefined {
    const lower = email.trim().toLowerCase();

    const adminEmail = this.config.get<string>("ADMIN_EMAIL")?.trim().toLowerCase();
    const adminHash = this.config.get<string>("ADMIN_PASSWORD_SHA256")?.trim();
    if (adminEmail && adminHash && adminEmail === lower) {
      return { email: adminEmail, role: "admin", passwordHash: adminHash };
    }

    const testers = this.parseTesterUsers();
    return testers.find((u) => u.email === lower);
  }

  private parseTesterUsers(): KnownUser[] {
    const raw = this.config.get<string>("TESTER_USERS_JSON");
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw) as Array<{
        email?: string;
        passwordSha256?: string;
        name?: string;
      }>;
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((u) => u.email && u.passwordSha256)
        .map((u) => ({
          email: u.email!.trim().toLowerCase(),
          role: "tester" as const,
          passwordHash: u.passwordSha256!.trim(),
          name: u.name,
        }));
    } catch (err) {
      this.logger.error(`TESTER_USERS_JSON failed to parse: ${(err as Error).message}`);
      return [];
    }
  }
}
