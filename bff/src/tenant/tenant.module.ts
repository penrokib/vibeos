import { Module } from "@nestjs/common";
import { TenantContextService } from "./tenant-context.service";

/**
 * Tenant context module. Other modules import this to inject TenantContextService
 * into services that need to scope queries to the request's tenant.
 *
 * Pattern (v1 row-level isolation):
 *   constructor(private readonly tenant: TenantContextService) {}
 *   findAll() {
 *     return this.prisma.draft.findMany({ where: { tenantId: this.tenant.tenantId } });
 *   }
 *
 * Hard rule: NEVER query a tenant-scoped table without a tenantId filter.
 * The Prisma migration coming in v1.1 hardening will make tenantId NOT NULL
 * on every multi-tenant table + add a per-table check that fails-loud on omission.
 */
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class TenantModule {}
