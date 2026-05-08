# Multi-tenancy in vibeOS

## v1 — row-level isolation (shipped in cycle 4)

- Every JWT carries a `tenantId` (UUID for new OSS users, `"roki"` for the legacy single-tenant rokibrain instance).
- `TenantContextService` (request-scoped, NestJS) exposes `tenantId` + `userId` to any service that needs to scope a query.
- Service convention: every Prisma query against a multi-tenant table includes `where: { tenantId: this.tenant.tenantId }`.
- Hard rule: a tenant-scoped table read without that filter is a class-A bug (Dewx pattern, see `feedback-...md`). PR review check: every new `findMany` / `findFirst` on tenant tables must include the filter.

## v1.1 hardening — schema-per-tenant Postgres isolation

Currently deferred. Reasons:

1. Prisma's schema-per-tenant story is awkward (one Prisma client per tenant, or runtime `SET search_path`). Both have rough edges.
2. Row-level with a `tenantId` index gets you 95% of the protection at 5% of the engineering cost.
3. v1's first OSS users will be solo founders running their own instance. The blast radius of a row-level mistake is one user's data, not all users'.

What v1.1 hardening adds:

- Postgres `CREATE SCHEMA tenant_<id>` on signup
- Per-request middleware: `SET LOCAL search_path = tenant_<id>, public`
- Migration runner that applies new migrations to all tenant schemas in a transaction
- Concurrency test: 100 parallel signups → 100 schemas, no race
- Backup/restore-by-tenant tooling

Track via the v1.1 milestone in `docs/ROADMAP.md` (added in cycle 30).

## Hard wall — banned bypass patterns

These are NEVER acceptable and a PR with any of them is blocked:

- Hardcoded `tenantId: "roki"` in production code
- Reading `tenantId` from request body / query params (must come from JWT only)
- `where: { tenantId: undefined }` (Prisma silently drops the filter — breaks tenancy)
- Disabling the `JwtAuthGuard` on a tenant-scoped endpoint without an explicit `@Public()` + a comment explaining the audit boundary

## How to add a new tenant-scoped table

1. In `packages/database/prisma/schema.prisma`: add `tenantId String` + `@@index([tenantId])`.
2. In the service that touches the table: inject `TenantContextService`.
3. Every Prisma query: add `where: { tenantId: this.tenant.tenantId }` (or merge into existing `where`).
4. Every create: add `data: { ..., tenantId: this.tenant.tenantId }`.
5. Add a unit test: 2 tenants, write rows, assert tenant A can't see tenant B's data.
