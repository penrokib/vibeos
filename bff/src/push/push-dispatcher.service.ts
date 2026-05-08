import { Injectable, Logger } from "@nestjs/common";
import * as apn from "@parse/node-apn";
import type {
  ApnsTokenRecord,
  DispatchResult,
  PushDispatchInput,
  PushTrigger,
} from "./push.types";

/**
 * Content-free alert copy per trigger.
 *
 * HARDWALL: these strings must NEVER embed user-generated content — no names,
 * no message snippets, no draft text. APNs is not E2E encrypted.
 */
const TRIGGER_COPY: Record<PushTrigger, { title: string; body: string }> = {
  "draft-ready": {
    title: "Draft ready",
    body: "A new draft is waiting for your review.",
  },
  "limit-prompt": {
    title: "Action needed",
    body: "A limit prompt requires your attention.",
  },
  "dm-mention": {
    title: "New message",
    body: "You have a new mention or direct message.",
  },
  "system-alert": {
    title: "System alert",
    body: "vibeOS requires your attention.",
  },
};

/**
 * PushDispatcherService — manages APNs device tokens and fires content-free
 * push notifications for the 4 trigger types.
 *
 * Storage: in-memory Map for v1. v1.1 hardening migrates to Postgres.
 *
 * Tenant isolation guarantee: dispatch() only ever reads tokens registered
 * under the same tenantId. Cross-tenant send is structurally impossible.
 *
 * Graceful degrade: if APNs creds (APNS_KEY_BASE64 / APNS_KEY_ID /
 * APNS_TEAM_ID) are absent, the service logs a warning and returns
 * { sent: 0, reason: "APNS_NOT_CONFIGURED" }. It NEVER throws so the rest of
 * BFF stays healthy during local dev / pre-cert stages.
 */
@Injectable()
export class PushDispatcherService {
  private readonly logger = new Logger(PushDispatcherService.name);

  /**
   * tenantId → (deviceId → ApnsTokenRecord)
   *
   * Outer Map is never shared across tenants; inner Map is keyed by a stable
   * client-generated deviceId UUID.
   */
  private readonly store = new Map<string, Map<string, ApnsTokenRecord>>();

  /** Lazily-initialised APNs provider. null = not configured. */
  private provider: apn.Provider | null = null;

  /** APNs bundle ID (com.vibeos.ios). */
  private readonly bundleId: string;

  constructor() {
    this.bundleId =
      process.env["APNS_BUNDLE_ID"] ?? "com.vibeos.ios";

    const keyBase64 = process.env["APNS_KEY_BASE64"];
    const keyId = process.env["APNS_KEY_ID"];
    const teamId = process.env["APNS_TEAM_ID"];
    const production = process.env["APNS_PRODUCTION"] === "true";

    if (keyBase64 && keyId && teamId) {
      try {
        const keyBuffer = Buffer.from(keyBase64, "base64");
        this.provider = new apn.Provider({
          token: {
            key: keyBuffer,
            keyId,
            teamId,
          },
          production,
        });
        this.logger.log(
          `APNs provider initialised (production=${production}, bundleId=${this.bundleId})`,
        );
      } catch (err) {
        this.logger.warn(
          `APNs provider failed to initialise — push disabled: ${(err as Error).message}`,
        );
        this.provider = null;
      }
    } else {
      this.logger.warn(
        "APNS_KEY_BASE64 / APNS_KEY_ID / APNS_TEAM_ID not set — push disabled (graceful degrade)",
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Token registry
  // ─────────────────────────────────────────────────────────────────────────

  /** Stores (or upserts) an APNs token for a tenant + device pair. */
  register(tenantId: string, deviceId: string, token: string): void {
    let inner = this.store.get(tenantId);
    if (!inner) {
      inner = new Map();
      this.store.set(tenantId, inner);
    }
    inner.set(deviceId, { token, registeredAt: new Date() });
    this.logger.debug(
      `Registered APNs token for tenant=${tenantId} device=${deviceId}`,
    );
  }

  /** Removes the APNs token for a device. No-op if not found. */
  unregister(tenantId: string, deviceId: string): void {
    this.store.get(tenantId)?.delete(deviceId);
    this.logger.debug(
      `Unregistered APNs token for tenant=${tenantId} device=${deviceId}`,
    );
  }

  /**
   * Lists registered devices for a tenant.
   * Returns sanitised records — raw token is truncated to last 8 chars.
   */
  listDevices(
    tenantId: string,
  ): Array<{ deviceId: string; tokenSuffix: string; registeredAt: Date }> {
    const inner = this.store.get(tenantId);
    if (!inner) return [];
    return Array.from(inner.entries()).map(([deviceId, rec]) => ({
      deviceId,
      tokenSuffix: rec.token.slice(-8),
      registeredAt: rec.registeredAt,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dispatch
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Dispatches a content-free push notification to all (or filtered) devices
   * registered under input.tenantId.
   *
   * Returns a DispatchResult envelope — never throws.
   */
  async dispatch(input: PushDispatchInput): Promise<DispatchResult> {
    if (!this.provider) {
      this.logger.warn(
        `dispatch(${input.trigger}) skipped — APNS_NOT_CONFIGURED`,
      );
      return { sent: 0, failed: 0, reason: "APNS_NOT_CONFIGURED" };
    }

    const inner = this.store.get(input.tenantId);
    if (!inner || inner.size === 0) {
      this.logger.debug(
        `dispatch(${input.trigger}) — no devices for tenant=${input.tenantId}`,
      );
      return { sent: 0, failed: 0 };
    }

    // Apply optional deviceFilter
    const entries = Array.from(inner.entries()).filter(
      ([deviceId]) =>
        !input.deviceFilter || input.deviceFilter.includes(deviceId),
    );

    if (entries.length === 0) {
      return { sent: 0, failed: 0 };
    }

    const copy = TRIGGER_COPY[input.trigger];
    const notification = new apn.Notification();
    notification.topic = this.bundleId;
    notification.expiry = Math.floor(Date.now() / 1000) + 3600; // 1 h TTL
    notification.alert = { title: copy.title, body: copy.body };
    // content-available=1 lets the app silently refresh if foregrounded
    notification.contentAvailable = true;
    // Forward routing metadata — no user content, only identifiers
    notification.payload = {
      trigger: input.trigger,
      ...input.metadata,
    };

    const tokens = entries.map(([, rec]) => rec.token);

    try {
      const result = await this.provider.send(notification, tokens);
      this.logger.log(
        `dispatch(${input.trigger}) tenant=${input.tenantId} ` +
          `sent=${result.sent.length} failed=${result.failed.length}`,
      );
      if (result.failed.length > 0) {
        for (const f of result.failed) {
          this.logger.warn(
            `APNs failure device=${f.device} reason=${f.response?.reason ?? f.error?.message ?? "unknown"}`,
          );
        }
      }
      return { sent: result.sent.length, failed: result.failed.length };
    } catch (err) {
      this.logger.error(
        `dispatch(${input.trigger}) threw unexpectedly: ${(err as Error).message}`,
      );
      return { sent: 0, failed: tokens.length, reason: "DISPATCH_ERROR" };
    }
  }
}
