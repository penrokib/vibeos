/**
 * Mesh — shared types & enums (M03).
 * Mirrors design §2 envelope shapes + §4 column CHECK constraints exactly.
 */

export const MESH_PLATFORMS = [
  "whatsapp",
  "telegram",
  "discord",
  "email",
  "linkedin",
  "x",
  "instagram",
  "signal_blocked",
  "sms",
  "slack",
] as const;
export type MeshPlatform = (typeof MESH_PLATFORMS)[number];

export const MESH_ACCOUNT_STATUSES = [
  "pending",
  "connected",
  "qr_required",
  "disconnected",
  "frozen",
  "banned",
] as const;
export type MeshAccountStatus = (typeof MESH_ACCOUNT_STATUSES)[number];

export const MESH_COUNTER_BUCKETS = [
  "minute",
  "hour",
  "day",
  "unwarmed_day",
  "burst_60s",
] as const;
export type MeshCounterBucket = (typeof MESH_COUNTER_BUCKETS)[number];

/**
 * Anti-ban hard caps per §3 (WhatsApp baseline; per-account overrides
 * may live in mesh_accounts.policy_json — applied at the service layer).
 */
export const MESH_COUNTER_CAPS: Record<MeshCounterBucket, number> = {
  minute: 8,
  hour: 60,
  day: 300,
  unwarmed_day: 5,
  burst_60s: 5,
};
