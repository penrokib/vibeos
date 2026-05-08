import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The canonical heartbeat HMAC payload.
 *
 * Bind machineId + lastHeartbeatId + receivedAt so a captured signature
 * is useless for any other tuple. `lastHeartbeatId` may be the empty
 * string when a machine submits its very first heartbeat — the bind
 * still works because both client and server will compute against "".
 *
 * Format (deliberately simple — no JSON, no length-prefix, no
 * canonicalization beyond `|`-join, because every component has a
 * tightly constrained shape upstream: machineId is `[a-z0-9-]+`, the
 * UUID is fixed-format, and receivedAt is ISO8601). If we ever need to
 * widen the alphabet we'll switch to length-prefixed encoding.
 */
export function buildHeartbeatHmacPayload(input: {
  machineId: string;
  lastHeartbeatId: string;
  receivedAt: string;
}): string {
  return `${input.machineId}|${input.lastHeartbeatId}|${input.receivedAt}`;
}

/**
 * Compute the hex-encoded HMAC-SHA256 of the canonical payload using the
 * machine's `heartbeatSecret`. Output is lowercase hex (so `openssl dgst`
 * on the client side matches without a `tr` post-step).
 */
export function computeHeartbeatHmac(
  payload: string,
  heartbeatSecret: string,
): string {
  return createHmac("sha256", heartbeatSecret).update(payload).digest("hex");
}

/**
 * Constant-time hex-MAC comparison.
 *
 * Why constant-time: the naive `a === b` short-circuits on first
 * mismatch, leaking which prefix is correct via timing. `timingSafeEqual`
 * compares every byte regardless. Returns `false` (not throws) when
 * lengths differ — a length mismatch IS already a verdict, so the
 * timing-side-channel doesn't apply.
 *
 * Returns `true` iff both buffers decode and match.
 */
export function verifyHeartbeatHmac(
  expectedHex: string,
  providedHex: string,
): boolean {
  if (typeof expectedHex !== "string" || typeof providedHex !== "string") {
    return false;
  }
  // SHA-256 hex is 64 chars. If the client sent something else, fail
  // fast — but this also gates `Buffer.from(...,'hex')` (which silently
  // truncates non-hex input).
  if (expectedHex.length !== 64 || providedHex.length !== 64) {
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(providedHex)) return false;

  const expectedBuf = Buffer.from(expectedHex, "hex");
  const providedBuf = Buffer.from(providedHex, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
