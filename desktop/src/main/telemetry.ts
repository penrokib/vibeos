// =============================================================================
// rokibrain.app — Telemetry scaffold (M16 / Cycle-29)
// -----------------------------------------------------------------------------
// Opt-in, privacy-first crash reporting. Default: OFF.
//
// Hard walls:
//   - telemetry_enabled secret MUST be "true" for any data to leave the device.
//   - reportCrash MUST scrub PII (email, phone, JWT) before sending.
//   - If VIBEOS_TELEMETRY_DSN is absent, reportCrash is always a no-op.
//   - This file NEVER reads from the filesystem directly — it receives a
//     `getSecret` callback from main so it stays testable in isolation.
// =============================================================================

import { app } from 'electron';
import os from 'node:os';

/** Shape returned by the `getSecret` callback. */
type GetSecretFn = (key: string) => Promise<string | null>;

// ---- module state -----------------------------------------------------------

let _telemetryEnabled = false;
let _dsn: string | null = null;

// ---- PII scrubbing ----------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+|00)[0-9\s\-().]{7,20}/g;
// A JWT is three base64url segments separated by dots: xxxxx.yyyyy.zzzzz
const JWT_RE = /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g;

/**
 * Replace PII patterns in `text` with redacted placeholders.
 * Order matters: match JWT before email (JWT contains dots that look like emails).
 */
export function scrubbedText(text: string): string {
  return text
    .replace(JWT_RE, '[jwt-redacted]')
    .replace(EMAIL_RE, '[email-redacted]')
    .replace(PHONE_RE, '[phone-redacted]');
}

/**
 * Scrub an Error's message and stack in-place, returning a plain record
 * safe to serialize as a telemetry event.
 */
export function scrubError(err: unknown): {
  errorClass: string;
  message: string;
  stack: string;
  appVersion: string;
  osName: string;
  osVersion: string;
  locale: string;
} {
  const isErr = err instanceof Error;
  const rawMessage = isErr ? err.message : String(err);
  const rawStack = isErr && err.stack ? err.stack : '';

  return {
    errorClass: isErr ? err.constructor.name : 'UnknownError',
    message: scrubbedText(rawMessage),
    stack: scrubbedText(rawStack),
    appVersion: app.getVersion?.() ?? process.env['npm_package_version'] ?? '0.0.0',
    osName: os.type(),
    osVersion: os.release(),
    locale: app.getLocale?.() ?? '',
  };
}

// ---- public API -------------------------------------------------------------

/**
 * Called once on app boot. Reads `telemetry_enabled` from secrets.
 * If VIBEOS_TELEMETRY_DSN is not set, telemetry stays a no-op regardless.
 */
export async function initTelemetry(getSecret: GetSecretFn): Promise<void> {
  try {
    const enabled = await getSecret('telemetry_enabled');
    _telemetryEnabled = enabled === 'true';
    _dsn = process.env['VIBEOS_TELEMETRY_DSN'] ?? null;

    if (_telemetryEnabled && _dsn) {
      // Future: call Sentry.init({ dsn: _dsn, ... }) here.
      // For v1 we log only — the scaffold is wired but the SDK is optional.
      console.log('[telemetry] crash reporting enabled (DSN configured)');
    } else if (_telemetryEnabled) {
      console.log('[telemetry] opt-in is true but VIBEOS_TELEMETRY_DSN is not set — no-op');
    } else {
      console.log('[telemetry] crash reporting off (default)');
    }
  } catch (err) {
    // Telemetry init MUST never crash the app.
    console.warn('[telemetry] initTelemetry error (swallowed):', err);
  }
}

/**
 * Report a crash. No-op unless the user opted in AND a DSN is configured.
 * Always scrubs PII before sending.
 */
export async function reportCrash(err: unknown): Promise<void> {
  if (!_telemetryEnabled || !_dsn) return;

  try {
    const event = scrubError(err);
    // Future: Sentry.captureEvent(event) — SDK init in initTelemetry.
    // For v1, POST to DSN is a structured log only:
    console.error('[telemetry] crash report (PII scrubbed):', event);
  } catch (innerErr) {
    // reportCrash MUST NOT throw — it's called from uncaughtException.
    console.warn('[telemetry] reportCrash error (swallowed):', innerErr);
  }
}
