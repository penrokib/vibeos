// =============================================================================
// rokibrain.app — auth (M12)
// -----------------------------------------------------------------------------
// BFF enrollment flow:
//   1. First launch: open browser to /fleet/enroll
//   2. Deep link rokibrain://enroll?token=... returns JWT
//   3. JWT stored encrypted via secrets.ts
//   4. Auto-refresh when <24h to expiry
//
// Hard walls (design §10):
//   - NEVER auto-renew past expiry without re-auth
//   - NEVER use dewx
//   - NEVER expose plaintext token to renderer
// =============================================================================

import { BrowserWindow, shell } from 'electron';
import type { AuthState, AuthStatusPayload } from '../shared/ipc-contracts';
import { deleteSecret, getSecret, setSecret } from './secrets';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_BFF_ENDPOINT = 'https://app.rokibrain.com';
const JWT_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

// -----------------------------------------------------------------------------
// JWT parsing (minimal — no full jose lib for v1)
// -----------------------------------------------------------------------------

interface JwtPayload {
  email?: string;
  exp?: number; // Unix timestamp in seconds
}

function parseJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload) as JwtPayload;
  } catch {
    return null;
  }
}

function isTokenExpired(token: string): boolean {
  const payload = parseJwt(token);
  if (!payload?.exp) return true;
  return Date.now() >= payload.exp * 1000;
}

function getTokenExpiryMs(token: string): number | null {
  const payload = parseJwt(token);
  return payload?.exp ? payload.exp * 1000 : null;
}

function shouldRefreshToken(token: string): boolean {
  const expiryMs = getTokenExpiryMs(token);
  if (!expiryMs) return false;
  return expiryMs - Date.now() < JWT_REFRESH_THRESHOLD_MS;
}

// -----------------------------------------------------------------------------
// Auth state management
// -----------------------------------------------------------------------------

let authState: AuthState = 'unenrolled';
let authEmail: string | undefined;
let authExpiresAt: string | undefined;
let currentEndpoint = DEFAULT_BFF_ENDPOINT;

// Broadcast function set by main index.ts after BrowserWindows are ready.
let broadcastFn: ((payload: AuthStatusPayload) => void) | null = null;

export function setAuthBroadcast(fn: (payload: AuthStatusPayload) => void): void {
  broadcastFn = fn;
}

function broadcast(): void {
  if (!broadcastFn) return;
  broadcastFn(getAuthStatus());
}

/**
 * Get current auth status (called from IPC handler).
 */
export function getAuthStatus(): AuthStatusPayload {
  return {
    state: authState,
    email: authEmail,
    expiresAt: authExpiresAt,
    endpoint: currentEndpoint,
  };
}

/**
 * Initialize auth state from stored secrets on app launch.
 */
export async function initAuth(): Promise<void> {
  const storedEndpoint = await getSecret('bff_endpoint');
  if (storedEndpoint) {
    currentEndpoint = storedEndpoint;
  }

  const storedJwt = await getSecret('bff_jwt');
  if (!storedJwt) {
    authState = 'unenrolled';
    broadcast();
    return;
  }

  // Check if token is expired or needs refresh.
  if (isTokenExpired(storedJwt)) {
    authState = 'expired';
    authEmail = undefined;
    authExpiresAt = undefined;
    broadcast();
    return;
  }

  const payload = parseJwt(storedJwt);
  authState = 'enrolled';
  authEmail = payload?.email;
  const expiryMs = getTokenExpiryMs(storedJwt);
  authExpiresAt = expiryMs ? new Date(expiryMs).toISOString() : undefined;
  broadcast();

  // Schedule auto-refresh if needed.
  if (shouldRefreshToken(storedJwt)) {
    // In v1, we don't implement auto-refresh API call — just surface expired state.
    // v2 will add BFF /auth/refresh endpoint.
    console.warn('[auth] JWT expires in <24h; manual re-enrollment required in v1');
  }
}

/**
 * Start BFF enrollment flow. Opens browser to /fleet/enroll.
 * Deep link rokibrain://enroll?token=... handled by handleEnrollDeepLink.
 */
export async function startEnrollment(endpoint: string): Promise<void> {
  authState = 'enrolling';
  currentEndpoint = endpoint;
  await setSecret('bff_endpoint', endpoint);
  broadcast();

  const enrollUrl = `${endpoint}/fleet/enroll`;
  await shell.openExternal(enrollUrl);
}

/**
 * Handle deep link rokibrain://enroll?token=...
 * Called from main index.ts protocol handler.
 */
export async function handleEnrollDeepLink(url: string): Promise<void> {
  const parsed = new URL(url);
  const token = parsed.searchParams.get('token');
  if (!token) {
    console.error('[auth] Deep link missing token param:', url);
    authState = 'unenrolled';
    broadcast();
    return;
  }

  // Validate token format (basic check).
  if (isTokenExpired(token)) {
    console.error('[auth] Deep link token already expired');
    authState = 'expired';
    broadcast();
    return;
  }

  const payload = parseJwt(token);
  if (!payload) {
    console.error('[auth] Deep link token invalid format');
    authState = 'unenrolled';
    broadcast();
    return;
  }

  // Store encrypted JWT.
  await setSecret('bff_jwt', token);
  authState = 'enrolled';
  authEmail = payload.email;
  const expiryMs = getTokenExpiryMs(token);
  authExpiresAt = expiryMs ? new Date(expiryMs).toISOString() : undefined;
  broadcast();

  // Show main window (enrollment complete).
  const windows = BrowserWindow.getAllWindows();
  if (windows[0]) {
    windows[0].show();
    windows[0].focus();
  }
}

/**
 * Logout: wipe secrets, reset auth state to unenrolled.
 */
export async function logout(): Promise<void> {
  await deleteSecret('bff_jwt');
  // Don't delete bff_endpoint — keep it for next enrollment.
  authState = 'unenrolled';
  authEmail = undefined;
  authExpiresAt = undefined;
  broadcast();
}

/**
 * Get current BFF JWT for API calls (main process only).
 * Returns null if not enrolled or expired.
 */
export async function getBffJwt(): Promise<string | null> {
  const jwt = await getSecret('bff_jwt');
  if (!jwt || isTokenExpired(jwt)) return null;
  return jwt;
}
