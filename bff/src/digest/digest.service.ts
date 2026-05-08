// =============================================================================
// BFF — DigestService
// -----------------------------------------------------------------------------
// Stores and serves the latest generated Digest per (tenantId, mode).
//
// Architecture note (v1):
//   - Storage is in-memory Map. The desktop daemon generates digests and pushes
//     them here via a future WebSocket event (see TODO below).
//   - v1.1 replaces the Map with a Postgres table (tenantId, mode, digest JSONB).
//   - For the v1 demo: GET returns a mock digest when no real one has been pushed.
//     This lets the iOS Today screen render immediately (cycle 19 already calls
//     this endpoint and falls back to its own mock on 404 — but let's serve
//     something useful instead).
//
// Hard walls:
//   - Tenant isolation: every read/write MUST be keyed on tenantId.
//   - No PII in digest items (enforced at the desktop generator level).
// =============================================================================

import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Digest, DigestItem } from './digest.types';

type CacheKey = `${string}:${'work' | 'personal'}`;

const cacheKey = (tenantId: string, mode: 'work' | 'personal'): CacheKey =>
  `${tenantId}:${mode}`;

@Injectable()
export class DigestService {
  /**
   * In-memory cache: Map<tenantId:mode, Digest>.
   * v1.1 TODO: replace with Prisma-backed table:
   *   CREATE TABLE digest (id uuid, tenant_id text, mode text, payload jsonb, generated_at timestamptz);
   */
  private readonly cache = new Map<CacheKey, Digest>();

  /**
   * Return the latest cached Digest for this tenant + mode.
   * Throws NotFoundException if no digest has been pushed yet (cycle 19 iOS falls
   * back gracefully on 404).
   */
  getLatest(tenantId: string, mode: 'work' | 'personal'): Digest {
    const key = cacheKey(tenantId, mode);
    const digest = this.cache.get(key);
    if (!digest) {
      throw new NotFoundException(
        `No digest found for mode=${mode}. Desktop daemon has not pushed one yet.`,
      );
    }
    return digest;
  }

  /**
   * Store (or overwrite) a Digest for this tenant + mode.
   * Called by:
   *   - POST /digest/refresh (admin trigger, v1 demo path)
   *   - TODO (v1.1): WebSocket push from desktop daemon when it generates a new digest.
   */
  upsert(tenantId: string, digest: Digest): void {
    const key = cacheKey(tenantId, digest.mode);
    this.cache.set(key, digest);
  }

  /**
   * Generate and cache a template digest synchronously.
   * Used by POST /digest/refresh when no real CC output is available (v1 demo).
   * Cycle 17 will wire this to the real DigestGenerator via a task queue.
   */
  generateTemplate(tenantId: string, mode: 'work' | 'personal'): Digest {
    const now = Date.now();
    const digest: Digest = {
      id: randomUUID(),
      generatedAt: now,
      mode,
      needsYou: [this.mockItem('decision', 'No pending decisions right now', 'Digest will update when desktop syncs')],
      whatHappened: [this.mockItem('alert', 'Digest service is live on BFF', 'Desktop daemon will push real data shortly')],
      stuck: [],
    };
    this.upsert(tenantId, digest);
    return digest;
  }

  // ---- internal helpers ----------------------------------------------------

  private mockItem(kind: Digest['needsYou'][number]['kind'], title: string, subtitle: string): DigestItem {
    return { id: randomUUID(), kind, title, subtitle, ts: Date.now() };
  }
}
