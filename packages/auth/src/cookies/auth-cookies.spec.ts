import {
  AUTH_COOKIE_BASE,
  AUTH_COOKIE_CLIENT_READABLE,
  AUTH_COOKIE_HTTPONLY,
} from "./auth-cookies";

describe("auth cookie attrs", () => {
  it("never uses sameSite=strict (would break OAuth + new-tab sessions)", () => {
    expect(AUTH_COOKIE_BASE.sameSite).toBe("lax");
    expect(AUTH_COOKIE_HTTPONLY.sameSite).toBe("lax");
    expect(AUTH_COOKIE_CLIENT_READABLE.sameSite).toBe("lax");
  });

  it("HttpOnly variant is httpOnly, client-readable is not", () => {
    expect(AUTH_COOKIE_HTTPONLY.httpOnly).toBe(true);
    expect(AUTH_COOKIE_CLIENT_READABLE.httpOnly).toBe(false);
  });

  it("path is always '/' for all variants", () => {
    expect(AUTH_COOKIE_BASE.path).toBe("/");
    expect(AUTH_COOKIE_HTTPONLY.path).toBe("/");
    expect(AUTH_COOKIE_CLIENT_READABLE.path).toBe("/");
  });
});
