/**
 * auth-cookies — channels Dewx apps/web/src/lib/auth-cookies.ts.
 *
 * Used by Phase 2 dashboard (app.rokibrain.com). The marketing site
 * (rokibrain.com) imports nothing from here.
 *
 * sameSite="lax" is CRITICAL — NEVER use "strict" on auth cookies.
 * Strict blocks new-tab sessions, external-link logins, and OAuth returns.
 */

export interface CookieAttrs {
  secure: boolean;
  sameSite: "lax";
  path: "/";
  httpOnly?: boolean;
  maxAge?: number;
}

export const AUTH_COOKIE_BASE: CookieAttrs = {
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
};

/** HttpOnly variant — tokens + ids that only server-side code should read. */
export const AUTH_COOKIE_HTTPONLY: CookieAttrs = {
  ...AUTH_COOKIE_BASE,
  httpOnly: true,
};

/** Client-readable — only for values JS needs (CSRF header value). */
export const AUTH_COOKIE_CLIENT_READABLE: CookieAttrs = {
  ...AUTH_COOKIE_BASE,
  httpOnly: false,
};

/**
 * Write the client-readable `at_client` cookie from browser JavaScript.
 * Every auth path that receives an access_token MUST also write `at_client`
 * so client-side gates can detect the session without reading httpOnly cookies.
 */
export function setClientAuthCookie(
  accessToken: string,
  maxAgeSeconds: number = 7 * 24 * 60 * 60,
): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:";
  document.cookie = `at_client=${accessToken}; path=/; SameSite=Lax; max-age=${maxAgeSeconds}${
    secure ? "; Secure" : ""
  }`;
}
