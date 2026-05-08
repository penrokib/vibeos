/**
 * push.types.ts — shared types for APNs push dispatcher.
 *
 * HARDWALL: push payloads are CONTENT-FREE. No message text, draft body,
 * recipient name, or any user-generated content ever enters a push payload.
 * APNs is not E2E-encrypted. v1.1 may add a separate encrypted rich-body flow,
 * but v1 is title-only.
 */

/** Four trigger types that cause a push to be dispatched. */
export type PushTrigger =
  | "draft-ready"
  | "limit-prompt"
  | "dm-mention"
  | "system-alert";

/** Body for POST /push/register-apns */
export interface RegisterApnsDto {
  /** Hex-encoded APNs device token returned by the iOS SDK. */
  token: string;
  /** Stable client-generated UUID that identifies this device install. */
  deviceId: string;
}

/** Input to PushDispatcherService.dispatch() */
export interface PushDispatchInput {
  trigger: PushTrigger;
  /** Must match the JWT tenantId of the registered device(s). */
  tenantId: string;
  /**
   * Optional allowlist of deviceIds. When supplied, only those devices
   * in the set receive the push. Omit to broadcast to the whole tenant.
   */
  deviceFilter?: string[];
  /**
   * Opaque deeplink/routing metadata forwarded in the APNs `data` key.
   * MUST NOT contain user-generated content — only routing identifiers
   * (e.g. { route: "drafts", draftId: "<uuid>" }).
   */
  metadata: Record<string, string>;
}

/** Response envelope from dispatch(). */
export interface DispatchResult {
  sent: number;
  failed: number;
  /** Present when APNs creds are not configured. */
  reason?: string;
}

/** Internal token record stored per (tenantId, deviceId). */
export interface ApnsTokenRecord {
  token: string;
  registeredAt: Date;
}
