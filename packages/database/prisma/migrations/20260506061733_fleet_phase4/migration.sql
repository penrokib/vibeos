-- Phase 4 — Fleet Ops + Knowledge embeddings.
-- Adds 4 tables: fleet_machines, fleet_heartbeats, fleet_enrollments,
-- learnings_embeddings (pgvector).
--
-- pgvector dependency: the learnings_embeddings.embedding column requires
-- the `vector` extension. The CREATE EXTENSION line below is idempotent
-- (IF NOT EXISTS) so re-running the migration on a DB that already has
-- pgvector is safe. On a fresh DB the extension MUST be installed
-- system-wide first (apt-get install postgresql-15-pgvector or similar)
-- otherwise CREATE EXTENSION will fail.
--
-- See: handoffs/agency-v3-inventory/35-fleet-ops.md and
--      knowledge.prisma comments for rationale.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "fleet_machines" (
    "id" UUID NOT NULL,
    "machine_id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "host_alias" TEXT,
    "os" TEXT NOT NULL,
    "public_ip" TEXT,
    "tailscale_ip" TEXT,
    "public_key" TEXT,
    "role" TEXT,
    "account" TEXT,
    "heartbeat_secret" TEXT,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMP(3),

    CONSTRAINT "fleet_machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_heartbeats" (
    "id" UUID NOT NULL,
    "machine_id" TEXT NOT NULL,
    "persona_count" INTEGER NOT NULL,
    "tmux_session_count" INTEGER NOT NULL,
    "ram_gb" DOUBLE PRECISION NOT NULL,
    "cpu_load" DOUBLE PRECISION NOT NULL,
    "account_quota" JSONB NOT NULL,
    "last_active_persona" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_enrollments" (
    "id" UUID NOT NULL,
    "machine_id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "requested_role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "tailscale_authkey" TEXT,
    "secrets_fetched_at" TIMESTAMP(3),
    "ssh_keys" JSONB,
    "persona_assignments" JSONB,
    "account" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learnings_embeddings" (
    "id" UUID NOT NULL,
    "persona" TEXT NOT NULL,
    "source_file" TEXT NOT NULL,
    "chunk_idx" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learnings_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fleet_machines_machine_id_key" ON "fleet_machines"("machine_id");

-- CreateIndex
CREATE INDEX "fleet_heartbeats_machine_id_received_at_idx" ON "fleet_heartbeats"("machine_id", "received_at");

-- CreateIndex
CREATE INDEX "fleet_enrollments_status_created_at_idx" ON "fleet_enrollments"("status", "created_at");

-- CreateIndex
CREATE INDEX "learnings_embeddings_persona_idx" ON "learnings_embeddings"("persona");

-- CreateIndex
CREATE INDEX "learnings_embeddings_persona_source_file_idx" ON "learnings_embeddings"("persona", "source_file");

-- CreateIndex
CREATE UNIQUE INDEX "learnings_embeddings_persona_source_file_chunk_idx_key" ON "learnings_embeddings"("persona", "source_file", "chunk_idx");
