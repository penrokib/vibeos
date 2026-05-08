/**
 * User roles. Single-tenant ("Roki only") for the dashboard surface, but the
 * bugs.rokibrain.com flow invites external testers — they get `tester` JWTs
 * scoped to bug-filing only. Existing tokens without a role default to admin
 * (see jwt.strategy.ts) so legacy sessions keep working.
 *
 * `persona` is the agency-v3 actor type — internal automation accounts that
 * spawn/dispatch on behalf of personas in `~/Projects/rokibrain/personas/`.
 * They get read access to the persona registry but cannot file bugs or hit
 * admin mutations.
 */
export const USER_ROLES = ["admin", "tester", "persona"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Shared auth payload. After jwt.strategy.validate() runs, `role` is always
 * populated — but the JWT-on-the-wire may omit it (older tokens default to admin).
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest {
  user: JwtPayload;
  headers: {
    authorization?: string;
  };
}
