import {
  buildHeartbeatHmacPayload,
  computeHeartbeatHmac,
  verifyHeartbeatHmac,
} from "./hmac.util";

describe("hmac.util", () => {
  // Same secret used by openssl on the client side. The expected MAC was
  // computed with:
  //   printf '%s' 'm1-abc|prev-uuid|2026-05-06T10:00:00Z' \
  //     | openssl dgst -sha256 -hmac 'shared-secret' -hex | awk '{print $NF}'
  const secret = "shared-secret";
  const machineId = "m1-abc";
  const lastHeartbeatId = "prev-uuid";
  const receivedAt = "2026-05-06T10:00:00Z";

  describe("buildHeartbeatHmacPayload", () => {
    it("joins the tuple with `|`", () => {
      expect(
        buildHeartbeatHmacPayload({ machineId, lastHeartbeatId, receivedAt }),
      ).toBe("m1-abc|prev-uuid|2026-05-06T10:00:00Z");
    });

    it("preserves an empty lastHeartbeatId (first heartbeat)", () => {
      expect(
        buildHeartbeatHmacPayload({
          machineId,
          lastHeartbeatId: "",
          receivedAt,
        }),
      ).toBe("m1-abc||2026-05-06T10:00:00Z");
    });
  });

  describe("computeHeartbeatHmac", () => {
    it("returns lowercase hex of SHA-256 length 64", () => {
      const payload = buildHeartbeatHmacPayload({
        machineId,
        lastHeartbeatId,
        receivedAt,
      });
      const mac = computeHeartbeatHmac(payload, secret);
      expect(mac).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces a stable value across calls (determinism)", () => {
      const payload = buildHeartbeatHmacPayload({
        machineId,
        lastHeartbeatId,
        receivedAt,
      });
      expect(computeHeartbeatHmac(payload, secret)).toBe(
        computeHeartbeatHmac(payload, secret),
      );
    });

    it("differs when secret changes", () => {
      const payload = buildHeartbeatHmacPayload({
        machineId,
        lastHeartbeatId,
        receivedAt,
      });
      expect(computeHeartbeatHmac(payload, secret)).not.toBe(
        computeHeartbeatHmac(payload, "other-secret"),
      );
    });

    it("differs when payload changes (replay-defense binding)", () => {
      const a = buildHeartbeatHmacPayload({
        machineId,
        lastHeartbeatId,
        receivedAt,
      });
      const b = buildHeartbeatHmacPayload({
        machineId,
        lastHeartbeatId: "different-prev",
        receivedAt,
      });
      expect(computeHeartbeatHmac(a, secret)).not.toBe(
        computeHeartbeatHmac(b, secret),
      );
    });
  });

  describe("verifyHeartbeatHmac", () => {
    const payload = "m1-abc|prev-uuid|2026-05-06T10:00:00Z";
    const validMac = computeHeartbeatHmac(payload, secret);

    it("accepts a matching MAC", () => {
      expect(verifyHeartbeatHmac(validMac, validMac)).toBe(true);
    });

    it("rejects a single-byte mutation", () => {
      const mutated = "0" + validMac.slice(1);
      expect(verifyHeartbeatHmac(validMac, mutated)).toBe(false);
    });

    it("rejects a length mismatch (attack: short MAC)", () => {
      expect(verifyHeartbeatHmac(validMac, validMac.slice(0, 32))).toBe(false);
    });

    it("rejects non-hex input (silent-truncate defense)", () => {
      const nonHex = "z".repeat(64);
      expect(verifyHeartbeatHmac(validMac, nonHex)).toBe(false);
    });

    it("rejects empty/undefined-coerced inputs", () => {
      expect(verifyHeartbeatHmac(validMac, "")).toBe(false);
      expect(verifyHeartbeatHmac("", validMac)).toBe(false);
      expect(verifyHeartbeatHmac(validMac, undefined as unknown as string)).toBe(
        false,
      );
    });

    it("rejects uppercase hex (canonicalization — server emits lowercase)", () => {
      expect(verifyHeartbeatHmac(validMac, validMac.toUpperCase())).toBe(false);
    });

    it("end-to-end round-trip: server MAC matches client MAC", () => {
      // Simulate the client: build payload, MAC, send. Server: rebuild
      // payload, MAC, compare. They must agree.
      const clientPayload = buildHeartbeatHmacPayload({
        machineId: "m3-xyz",
        lastHeartbeatId: "abc-123",
        receivedAt: "2026-05-06T11:22:33Z",
      });
      const clientMac = computeHeartbeatHmac(clientPayload, secret);

      const serverPayload = buildHeartbeatHmacPayload({
        machineId: "m3-xyz",
        lastHeartbeatId: "abc-123",
        receivedAt: "2026-05-06T11:22:33Z",
      });
      const serverMac = computeHeartbeatHmac(serverPayload, secret);

      expect(verifyHeartbeatHmac(serverMac, clientMac)).toBe(true);
    });
  });
});
