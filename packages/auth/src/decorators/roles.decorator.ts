import { SetMetadata } from "@nestjs/common";
import type { UserRole } from "../types";

export const ROLES_KEY = "roles";

/**
 * Restrict a controller or route to specific roles.
 * Usage: `@Roles("admin")` or `@Roles("admin", "tester")`.
 *
 * Pair with `RolesGuard` (added on the controller after `JwtAuthGuard`):
 *   `@UseGuards(JwtAuthGuard, RolesGuard)`
 *
 * Routes without `@Roles()` are open to any authenticated user (the
 * `JwtAuthGuard` still applies — `@Public()` is required to skip auth).
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
