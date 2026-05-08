import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { TailscaleService } from "./tailscale.service";

describe("TailscaleService", () => {
  let service: TailscaleService;
  let configValues: Record<string, string | undefined>;

  beforeEach(async () => {
    configValues = {};
    const moduleRef = await Test.createTestingModule({
      providers: [
        TailscaleService,
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => configValues[k],
          },
        },
      ],
    }).compile();
    service = moduleRef.get(TailscaleService);
  });

  describe("stub fallback", () => {
    it("returns a tskey-auth-stub-* value with stub=true when env missing", async () => {
      const result = await service.mintAuthKey({ role: "worker" });
      expect(result.stub).toBe(true);
      expect(result.id).toBeNull();
      expect(result.key).toMatch(/^tskey-auth-stub-[0-9a-f]{64}$/);
    });

    it("returns a stub when only one env var is set", async () => {
      configValues.TAILSCALE_OAUTH_CLIENT_ID = "id";
      const result = await service.mintAuthKey({ role: "worker" });
      expect(result.stub).toBe(true);
    });

    it("returns a stub when tailnet is missing", async () => {
      configValues.TAILSCALE_OAUTH_CLIENT_ID = "id";
      configValues.TAILSCALE_OAUTH_CLIENT_SECRET = "secret";
      const result = await service.mintAuthKey({ role: "worker" });
      expect(result.stub).toBe(true);
    });

    it("emits unique stub keys across calls (not constant)", async () => {
      const a = await service.mintAuthKey({ role: "worker" });
      const b = await service.mintAuthKey({ role: "worker" });
      expect(a.key).not.toBe(b.key);
    });

    it("never throws in stub mode (so the BFF doesn't crash on dev/CI)", async () => {
      await expect(service.mintAuthKey({ role: "worker" })).resolves.toBeDefined();
    });
  });

  describe("real-mint mode (env vars set)", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      configValues.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      configValues.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      configValues.TAILSCALE_TAILNET = "rokibrain.com";
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("POSTs to the Tailscale tailnet-keys endpoint with HTTP Basic auth", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "key-id-123", key: "tskey-auth-real-xyz" }),
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const result = await service.mintAuthKey({ role: "worker" });

      expect(result).toEqual({
        key: "tskey-auth-real-xyz",
        id: "key-id-123",
        stub: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "https://api.tailscale.com/api/v2/tailnet/rokibrain.com/keys",
      );
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      // Basic auth: base64 of client-id:client-secret
      expect(init.headers.Authorization).toBe(
        `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
      );

      const body = JSON.parse(init.body as string);
      expect(body.capabilities.devices.create).toMatchObject({
        reusable: false,
        ephemeral: false,
        preauthorized: true,
      });
      expect(body.capabilities.devices.create.tags).toEqual(
        expect.arrayContaining(["tag:worker", "tag:rokibrain-mesh"]),
      );
      expect(body.expirySeconds).toBe(3600);
    });

    it("includes extraTags when provided", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "k", key: "tskey-auth-real" }),
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await service.mintAuthKey({
        role: "scraper",
        extraTags: ["tag:role-scraper"],
      });

      const init = fetchMock.mock.calls[0][1];
      const body = JSON.parse(init.body as string);
      expect(body.capabilities.devices.create.tags).toEqual([
        "tag:worker",
        "tag:rokibrain-mesh",
        "tag:role-scraper",
      ]);
    });

    it("URL-encodes the tailnet (defense against weird chars)", async () => {
      configValues.TAILSCALE_TAILNET = "weird tailnet/with-slashes";
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "k", key: "tskey-auth-real" }),
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await service.mintAuthKey({ role: "worker" });

      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("weird%20tailnet%2Fwith-slashes");
    });

    it("throws when the Tailscale API returns non-2xx", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("unauthorized"),
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await expect(service.mintAuthKey({ role: "worker" })).rejects.toThrow(
        /HTTP 401/,
      );
    });

    it("throws when Tailscale returns a body without `key`", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "k" }),
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await expect(service.mintAuthKey({ role: "worker" })).rejects.toThrow(
        /no `key` field/,
      );
    });

    it("propagates network errors (so caller can audit + retry)", async () => {
      const fetchMock = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await expect(service.mintAuthKey({ role: "worker" })).rejects.toThrow(
        "ECONNREFUSED",
      );
    });

    it("respects custom expirySeconds", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "k", key: "tskey-auth-real" }),
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await service.mintAuthKey({ role: "worker", expirySeconds: 600 });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.expirySeconds).toBe(600);
    });
  });
});
