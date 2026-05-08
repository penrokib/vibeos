import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import type { JwtPayload, UserRole } from "../types";

/**
 * Role-based access guard. Reads the `@Roles(...)` decorator from the route
 * (or class) and rejects requests whose JWT carries a different role.
 *
 * Always pair AFTER `JwtAuthGuard` so `req.user` is populated:
 *   `@UseGuards(JwtAuthGuard, RolesGuard)`
 *
 * No `@Roles()` on the route ⇒ allow any authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const user = req.user;
    if (!user) throw new UnauthorizedException("authentication required");
    if (!required.includes(user.role)) {
      throw new ForbiddenException(
        `role ${user.role} not permitted (requires ${required.join(" or ")})`,
      );
    }
    return true;
  }
}
