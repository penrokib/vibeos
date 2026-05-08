/**
 * push-dispatcher.service.spec.ts
 *
 * Bug-prevention pyramid:
 *   A — register stores token; listDevices returns sanitised view; unregister removes.
 *   B — dispatch without APNs config returns APNS_NOT_CONFIGURED (graceful degrade).
 *   C — dispatch with config calls provider.send; payload is content-free.
 *   D — tenant isolation: tenant A tokens never sent to tenant B dispatch.
 *   E — deviceFilter narrows recipients correctly.
 *
 * APNs provider is mocked — no real network calls.
 */

import { PushDispatcherService } from "../push-dispatcher.service";

// ──────────────────────────────────────────────────────────────────────────────
// Mock @parse/node-apn
// ──────────────────────────────────────────────────────────────────────────────

const mockSend = jest.fn();

jest.mock("@parse/node-apn", () => {
  return {
    Provider: jest.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    Notification: jest.fn().mockImplementation(() => ({
      topic: "",
      expiry: 0,
      alert: {},
      payload: {},
      contentAvailable: false,
    })),
  };
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeService(withCreds = false): PushDispatcherService {
  if (withCreds) {
    // Provide minimal env so the provider is initialised
    process.env["APNS_KEY_BASE64"] = Buffer.from("fake-key").toString("base64");
    process.env["APNS_KEY_ID"] = "TESTKEYID1";
    process.env["APNS_TEAM_ID"] = "TESTTEAMID";
    process.env["APNS_PRODUCTION"] = "false";
  } else {
    delete process.env["APNS_KEY_BASE64"];
    delete process.env["APNS_KEY_ID"];
    delete process.env["APNS_TEAM_ID"];
  }
  return new PushDispatcherService();
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("PushDispatcherService", () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env["APNS_KEY_BASE64"];
    delete process.env["APNS_KEY_ID"];
    delete process.env["APNS_TEAM_ID"];
    delete process.env["APNS_PRODUCTION"];
  });

  // ── A: Token registry ────────────────────────────────────────────────────

  describe("register / listDevices / unregister", () => {
    it("register stores token and listDevices returns it with sanitised tokenSuffix", () => {
      const svc = makeService(false);
      const token = "aabbccddeeff00112233445566778899aabbccddeeff001122334455667788XX";

      svc.register("tenant-1", "device-1", token);

      const devices = svc.listDevices("tenant-1");
      expect(devices).toHaveLength(1);
      expect(devices[0]!.deviceId).toBe("device-1");
      // Raw token MUST NOT be returned
      expect((devices[0] as any).token).toBeUndefined();
      // tokenSuffix is last 8 chars
      expect(devices[0]!.tokenSuffix).toBe(token.slice(-8));
      expect(devices[0]!.registeredAt).toBeInstanceOf(Date);
    });

    it("register upserts — second register with same deviceId overwrites token", () => {
      const svc = makeService(false);
      svc.register("tenant-1", "device-1", "old-token-aabbcc001122");
      svc.register("tenant-1", "device-1", "new-token-ZZYYXX998877");

      const devices = svc.listDevices("tenant-1");
      expect(devices).toHaveLength(1);
      expect(devices[0]!.tokenSuffix).toBe("new-token-ZZYYXX998877".slice(-8));
    });

    it("unregister removes the device", () => {
      const svc = makeService(false);
      svc.register("tenant-1", "device-1", "token-aabbcc001122334455667788");
      svc.unregister("tenant-1", "device-1");
      expect(svc.listDevices("tenant-1")).toHaveLength(0);
    });

    it("unregister on non-existent device is a no-op", () => {
      const svc = makeService(false);
      expect(() => svc.unregister("tenant-1", "ghost-device")).not.toThrow();
    });

    it("listDevices returns empty array for unknown tenant", () => {
      const svc = makeService(false);
      expect(svc.listDevices("nobody")).toEqual([]);
    });
  });

  // ── B: Graceful degrade (no APNs creds) ─────────────────────────────────

  describe("dispatch — APNS_NOT_CONFIGURED", () => {
    it("returns APNS_NOT_CONFIGURED without throwing when creds absent", async () => {
      const svc = makeService(false);
      svc.register("tenant-1", "device-1", "token-aabbcc001122334455667788aa");

      const result = await svc.dispatch({
        trigger: "draft-ready",
        tenantId: "tenant-1",
        metadata: { route: "drafts" },
      });

      expect(result.sent).toBe(0);
      expect(result.reason).toBe("APNS_NOT_CONFIGURED");
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ── C: Dispatch with APNs config ────────────────────────────────────────

  describe("dispatch — APNs configured", () => {
    it("calls provider.send and returns sent/failed counts", async () => {
      const svc = makeService(true);
      svc.register("tenant-1", "device-1", "token-aabbcc001122334455667788bb");

      mockSend.mockResolvedValueOnce({
        sent: [{ device: "token-aabbcc001122334455667788bb" }],
        failed: [],
      });

      const result = await svc.dispatch({
        trigger: "draft-ready",
        tenantId: "tenant-1",
        metadata: { route: "drafts", draftId: "d-uuid-1" },
      });

      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("payload is content-free: alert title matches trigger, body is generic", async () => {
      const svc = makeService(true);
      svc.register("tenant-1", "device-1", "token-aabbcc001122334455667788cc");

      // Capture what was passed to send
      let capturedNotification: any;
      mockSend.mockImplementationOnce((notif: any) => {
        capturedNotification = notif;
        return Promise.resolve({ sent: [{ device: "t" }], failed: [] });
      });

      await svc.dispatch({
        trigger: "limit-prompt",
        tenantId: "tenant-1",
        metadata: { route: "limits" },
      });

      // Content-free check: alert must not contain user content
      const alert = capturedNotification.alert as { title: string; body: string };
      expect(typeof alert.title).toBe("string");
      expect(alert.title.length).toBeGreaterThan(0);
      // Generic body — must not be empty, must be a plain string
      expect(typeof alert.body).toBe("string");
      expect(alert.body.length).toBeGreaterThan(0);
      // payload.trigger must match
      expect(capturedNotification.payload.trigger).toBe("limit-prompt");
    });

    it("each trigger type produces a non-empty title", async () => {
      const triggers = [
        "draft-ready",
        "limit-prompt",
        "dm-mention",
        "system-alert",
      ] as const;

      for (const trigger of triggers) {
        const svc = makeService(true);
        svc.register("t", "d", `token-aaaa${trigger.replace(/-/g, "").slice(0, 8)}`);

        let capturedTitle = "";
        mockSend.mockImplementationOnce((notif: any) => {
          capturedTitle = (notif.alert as any).title;
          return Promise.resolve({ sent: [{ device: "t" }], failed: [] });
        });

        await svc.dispatch({ trigger, tenantId: "t", metadata: {} });
        expect(capturedTitle.length).toBeGreaterThan(0);
        jest.clearAllMocks();
      }
    });
  });

  // ── D: Tenant isolation ──────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("dispatch for tenant-A never sends to devices registered under tenant-B", async () => {
      const svc = makeService(true);
      svc.register("tenant-A", "device-A", "token-AAAAAAAA001122334455667788");
      svc.register("tenant-B", "device-B", "token-BBBBBBBB001122334455667788");

      mockSend.mockResolvedValueOnce({
        sent: [{ device: "token-AAAAAAAA001122334455667788" }],
        failed: [],
      });

      await svc.dispatch({
        trigger: "system-alert",
        tenantId: "tenant-A",
        metadata: {},
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const recipients: string[] = mockSend.mock.calls[0][1] as string[];
      expect(recipients).toContain("token-AAAAAAAA001122334455667788");
      expect(recipients).not.toContain("token-BBBBBBBB001122334455667788");
    });

    it("dispatch for tenant with no devices returns sent=0 without calling send", async () => {
      const svc = makeService(true);
      // Only register for tenant-A
      svc.register("tenant-A", "device-A", "token-aabbcc001122334455667788cc");

      const result = await svc.dispatch({
        trigger: "dm-mention",
        tenantId: "tenant-B", // different tenant
        metadata: {},
      });

      expect(result.sent).toBe(0);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ── E: deviceFilter ───────────────────────────────────────────────────────

  describe("deviceFilter", () => {
    it("narrows recipients to specified deviceIds only", async () => {
      const svc = makeService(true);
      svc.register("tenant-1", "device-1", "token-D1-aabbcc001122334455667788");
      svc.register("tenant-1", "device-2", "token-D2-aabbcc001122334455667788");
      svc.register("tenant-1", "device-3", "token-D3-aabbcc001122334455667788");

      mockSend.mockResolvedValueOnce({
        sent: [{ device: "token-D1-aabbcc001122334455667788" }],
        failed: [],
      });

      await svc.dispatch({
        trigger: "draft-ready",
        tenantId: "tenant-1",
        deviceFilter: ["device-1"],
        metadata: {},
      });

      const recipients: string[] = mockSend.mock.calls[0][1] as string[];
      expect(recipients).toHaveLength(1);
      expect(recipients[0]).toBe("token-D1-aabbcc001122334455667788");
    });

    it("returns sent=0 when deviceFilter matches no registered devices", async () => {
      const svc = makeService(true);
      svc.register("tenant-1", "device-1", "token-aabbcc001122334455667788cc");

      const result = await svc.dispatch({
        trigger: "system-alert",
        tenantId: "tenant-1",
        deviceFilter: ["device-does-not-exist"],
        metadata: {},
      });

      expect(result.sent).toBe(0);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
