// =============================================================================
// rokibrain.app — BFF REST API client (M07)
// -----------------------------------------------------------------------------
// Typed fetch-based client for talking to https://app.rokibrain.com/api/*.
// JWT auth from ROKIBRAIN_DEV_JWT env var (until M12 adds Keychain storage).
//
// Hard walls:
//   - NEVER bypass JWT (no anonymous fallback).
//   - All fetch calls include timeout (30s default).
//   - Renderer cannot call this directly (no Node APIs) — must go via main IPC.
// =============================================================================

const BFF_BASE_URL =
  process.env.ROKIBRAIN_BFF_URL ?? 'https://app.rokibrain.com';
const REQUEST_TIMEOUT_MS = 30_000;

/** JWT token from env. M12 will replace with Keychain access. */
function getAuthToken(): string | null {
  return process.env.ROKIBRAIN_DEV_JWT ?? null;
}

/** Base fetch with timeout + auth headers. */
async function fetchWithAuth(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('ROKIBRAIN_DEV_JWT not set — cannot authenticate to BFF');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${BFF_BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `BFF ${path} failed: ${response.status} ${response.statusText} — ${text}`,
      );
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------------------------------------------------------
// Drafts API (mesh-authored drafts pending approval)
// -----------------------------------------------------------------------------

export interface Draft {
  id: string;
  account_id: string;
  contact_external_id: string;
  body: string;
  persona_slug: string | null;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  refused_reasons: string[] | null;
  similarity_score: number | null;
}

export interface DraftApproveRequest {
  approver: string;
  two_factor?: string | null;
}

export interface DraftRejectRequest {
  reason?: string;
}

export async function listPendingDrafts(): Promise<Draft[]> {
  const response = await fetchWithAuth('/agency/drafts/pending');
  return response.json();
}

export async function approveDraft(
  draftId: string,
  request: DraftApproveRequest,
): Promise<void> {
  await fetchWithAuth(`/agency/drafts/${draftId}/approve`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function rejectDraft(
  draftId: string,
  request: DraftRejectRequest,
): Promise<void> {
  await fetchWithAuth(`/agency/drafts/${draftId}/reject`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

// -----------------------------------------------------------------------------
// Decisions API (decisions queue from BFF)
// -----------------------------------------------------------------------------

export interface Decision {
  id: string;
  title: string;
  persona: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  options: string[];
  context?: string;
  created_at: string;
  decided_at: string | null;
  decided_option: string | null;
}

export interface DecisionUpdateRequest {
  decided_option: string;
}

export async function listDecisions(): Promise<Decision[]> {
  const response = await fetchWithAuth('/decisions');
  return response.json();
}

export async function updateDecision(
  decisionId: string,
  request: DecisionUpdateRequest,
): Promise<void> {
  await fetchWithAuth(`/decisions/${decisionId}`, {
    method: 'PATCH',
    body: JSON.stringify(request),
  });
}
