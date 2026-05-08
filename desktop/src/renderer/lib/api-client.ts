// =============================================================================
// rokibrain.app — typed BFF API client (M08)
// -----------------------------------------------------------------------------
// Lightweight fetch wrapper for /knowledge/search and /agency/* endpoints.
// M07 drafts/decisions may extend this; for now we stub the essentials.
// Hard wall: read-only — no writes to persona files from desktop.
// =============================================================================

const BFF_URL =
  (typeof import.meta !== 'undefined' && (import.meta as { env?: { VITE_BFF_URL?: string } }).env?.VITE_BFF_URL) ??
  'http://localhost:3000';

export interface SearchHit {
  id: string;
  persona: string;
  sourceFile: string;
  chunkIdx: number;
  content: string;
  score: number;
}

export interface SearchParams {
  q: string;
  persona?: string;
  top_k?: number;
  min_score?: number;
}

export interface PersonaSummary {
  slug: string;
  layer: 'c-level' | 'senior-manager' | 'lead' | 'coordinator' | 'specialist' | 'unknown';
  account: string;
  reportsTo: string | null;
  inboxDepth: number;
  outboxUnread: number;
  tabAlive: boolean;
  spawnEligible: boolean;
  lastActiveAt: string | null;
  currentTask: string | null;
  model: string | null;
}

export interface PersonaDetail extends PersonaSummary {
  identity: string;
  outboxTail: string[];
  lifetimeTaskCount: number;
  currentIterCount: number;
}

class ApiClient {
  private token: string | null = null;

  setToken(t: string): void {
    this.token = t;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
    const res = await fetch(`${BFF_URL}${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>');
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  // ─── Knowledge Search ──────────────────────────────────────────────────

  async searchKnowledge(params: SearchParams): Promise<SearchHit[]> {
    const q = new URLSearchParams();
    q.set('q', params.q);
    if (params.persona) q.set('persona', params.persona);
    if (params.top_k) q.set('top_k', String(params.top_k));
    if (params.min_score) q.set('min_score', String(params.min_score));
    return this.fetch<SearchHit[]>(`/knowledge/search?${q.toString()}`);
  }

  // ─── Agency / Personas ─────────────────────────────────────────────────

  async listPersonas(filter?: {
    layer?: string;
    account?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<PersonaSummary[]> {
    const q = new URLSearchParams();
    if (filter?.layer) q.set('layer', filter.layer);
    if (filter?.account) q.set('account', filter.account);
    if (filter?.search) q.set('search', filter.search);
    if (filter?.limit) q.set('limit', String(filter.limit));
    if (filter?.offset) q.set('offset', String(filter.offset));
    const qs = q.toString();
    return this.fetch<PersonaSummary[]>(`/agency/personas${qs ? `?${qs}` : ''}`);
  }

  async getPersona(slug: string): Promise<PersonaDetail> {
    return this.fetch<PersonaDetail>(`/agency/personas/${slug}`);
  }

  async nudgePersona(slug: string): Promise<{ ok: boolean }> {
    return this.fetch<{ ok: boolean }>(`/agency/personas/${slug}/nudge`, {
      method: 'POST',
    });
  }
}

export const apiClient = new ApiClient();
