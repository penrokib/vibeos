import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { USER_ROLES, type JwtPayload, type UserRole } from "@vibeos/auth";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error("JWT_SECRET must be set before BFF can boot");
    }
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req) => req?.cookies?.access_token ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(
    payload: Omit<JwtPayload, "role" | "tenantId"> & { role?: string; tenantId?: string },
  ): JwtPayload {
    if (!payload?.sub) throw new UnauthorizedException("Malformed token");
    // Default to "admin" so existing Roki tokens (issued before roles existed)
    // keep working. Tester tokens MUST carry an explicit `role: "tester"`.
    const role: UserRole = (USER_ROLES as readonly string[]).includes(payload.role ?? "")
      ? (payload.role as UserRole)
      : "admin";
    // Default to "roki" so legacy single-tenant tokens keep working. New OSS
    // signups populate tenantId with a UUID at issue time.
    const tenantId = payload.tenantId ?? "roki";
    return { ...payload, role, tenantId };
  }
}
