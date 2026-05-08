// =============================================================================
// BFF — DigestController
// =============================================================================

import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@vibeos/auth';
import { TenantContextService } from '../tenant/tenant-context.service';
import { DigestService } from './digest.service';

type DigestMode = 'work' | 'personal';

function parseMode(raw: string | undefined): DigestMode {
  return raw === 'personal' ? 'personal' : 'work';
}

/**
 * Digest endpoints consumed by the iOS Today screen (cycle 19).
 *
 * GET  /digest?mode=work|personal      — latest cached digest for this tenant
 * POST /digest/refresh?mode=work|...   — trigger template regen (v1 demo; cycle 17 = real CC)
 *
 * TODO (v1.1): add WebSocket push handler so the desktop daemon can push digests
 * directly here without requiring a manual POST /refresh.
 */
@Controller('digest')
@UseGuards(JwtAuthGuard)
export class DigestController {
  constructor(
    private readonly digest: DigestService,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Return the latest cached Digest for this tenant + mode.
   * iOS falls back to its own mock on 404 (Digest.swift line 52-85), so returning
   * 404 is safe and preferred over returning stale data.
   */
  @Get()
  getLatest(@Query('mode') mode?: string) {
    const tenantId = this.tenant.tenantId;
    const m = parseMode(mode);
    try {
      return this.digest.getLatest(tenantId, m);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new NotFoundException('Digest not available');
    }
  }

  /**
   * Trigger a digest regeneration for this tenant + mode.
   *
   * v1: generates a deterministic template digest immediately.
   * Cycle 17: enqueues a real CC job via the desktop daemon task queue.
   *
   * Rate-limiting and admin-only enforcement is deferred to v1.1 (API gateway
   * or NestJS Throttler). For v1 any authenticated user in the tenant can call this.
   */
  @Post('refresh')
  @HttpCode(200)
  refresh(@Query('mode') mode?: string) {
    const tenantId = this.tenant.tenantId;
    const m = parseMode(mode);
    return this.digest.generateTemplate(tenantId, m);
  }
}
