import { Inject, Injectable, Scope, UnauthorizedException } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { JwtPayload } from "@vibeos/auth";

/**
 * Request-scoped tenant context. Read after `JwtAuthGuard` has populated
 * `req.user`; throws if invoked outside an authenticated request.
 *
 * v1 ships row-level isolation: services read `tenantId` here and add it to
 * every Prisma `where` clause. Schema-per-tenant Postgres isolation is
 * deferred — see docs/MULTITENANCY.md (v1.1 hardening).
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantContextService {
  constructor(
    @Inject(REQUEST) private readonly request: { user?: JwtPayload },
  ) {}

  get tenantId(): string {
    const id = this.request.user?.tenantId;
    if (!id) {
      throw new UnauthorizedException(
        "TenantContextService used before JwtAuthGuard populated req.user",
      );
    }
    return id;
  }

  get userId(): string {
    const sub = this.request.user?.sub;
    if (!sub) {
      throw new UnauthorizedException("No user on request");
    }
    return sub;
  }
}
