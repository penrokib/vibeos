import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Marks a route as public (skips JwtAuthGuard).
 * Use sparingly — controllers default to authenticated per Dewx Class-C rule.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
