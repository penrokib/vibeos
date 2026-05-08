// =============================================================================
// digest.service.spec.ts
// -----------------------------------------------------------------------------
// Jest unit tests for DigestService.
// No NestJS testing module needed — service is a plain injectable with no deps.
// =============================================================================

import { NotFoundException } from '@nestjs/common';
import { DigestService } from '../digest.service';
import type { Digest } from '../digest.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDigest(mode: 'work' | 'personal', overrides: Partial<Digest> = {}): Digest {
  return {
    id: 'test-digest-id',
    generatedAt: Date.now(),
    mode,
    needsYou: [],
    whatHappened: [],
    stuck: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DigestService', () => {
  let service: DigestService;

  beforeEach(() => {
    service = new DigestService();
  });

  describe('getLatest()', () => {
    it('throws NotFoundException when no digest has been pushed for this tenant+mode', () => {
      expect(() => service.getLatest('tenant-a', 'work')).toThrow(NotFoundException);
    });

    it('throws NotFoundException when no digest for this mode (other mode exists)', () => {
      const digest = makeDigest('personal');
      service.upsert('tenant-a', digest);

      expect(() => service.getLatest('tenant-a', 'work')).toThrow(NotFoundException);
    });

    it('returns the cached digest after upsert', () => {
      const digest = makeDigest('work');
      service.upsert('tenant-a', digest);

      const result = service.getLatest('tenant-a', 'work');
      expect(result).toBe(digest);
    });

    it('tenant A digest is never returned for tenant B (isolation)', () => {
      const digest = makeDigest('work');
      service.upsert('tenant-a', digest);

      expect(() => service.getLatest('tenant-b', 'work')).toThrow(NotFoundException);
    });

    it('mode parameter is honored — work and personal are isolated within same tenant', () => {
      const workDigest = makeDigest('work', { id: 'work-id' });
      const personalDigest = makeDigest('personal', { id: 'personal-id' });
      service.upsert('tenant-a', workDigest);
      service.upsert('tenant-a', personalDigest);

      expect(service.getLatest('tenant-a', 'work').id).toBe('work-id');
      expect(service.getLatest('tenant-a', 'personal').id).toBe('personal-id');
    });
  });

  describe('upsert()', () => {
    it('overwrites an existing digest for the same tenant+mode', () => {
      const first = makeDigest('work', { id: 'first-id' });
      const second = makeDigest('work', { id: 'second-id' });
      service.upsert('tenant-a', first);
      service.upsert('tenant-a', second);

      expect(service.getLatest('tenant-a', 'work').id).toBe('second-id');
    });

    it('does not affect the other mode when upserting work', () => {
      const personal = makeDigest('personal', { id: 'personal-id' });
      service.upsert('tenant-a', personal);
      service.upsert('tenant-a', makeDigest('work', { id: 'work-id' }));

      expect(service.getLatest('tenant-a', 'personal').id).toBe('personal-id');
    });
  });

  describe('generateTemplate()', () => {
    it('returns a valid Digest with the requested mode', () => {
      const digest = service.generateTemplate('tenant-a', 'work');

      expect(digest.mode).toBe('work');
      expect(digest.id).toBeTruthy();
      expect(typeof digest.generatedAt).toBe('number');
    });

    it('caches the generated template so getLatest returns it immediately after', () => {
      const digest = service.generateTemplate('tenant-a', 'personal');
      const fetched = service.getLatest('tenant-a', 'personal');

      expect(fetched).toBe(digest);
    });

    it('two tenants generating templates do not interfere', () => {
      service.generateTemplate('tenant-a', 'work');
      service.generateTemplate('tenant-b', 'work');

      const a = service.getLatest('tenant-a', 'work');
      const b = service.getLatest('tenant-b', 'work');

      expect(a.id).not.toBe(b.id);
    });
  });
});
