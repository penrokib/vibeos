-- Mesh — desktop app comms surface (M03, 2026-05-07)
-- See state/rokibrain-app-v1-design-2026-05-07.md §4
-- Additive only: no DROP, no ALTER, no rename of any existing table/column.
-- Required extensions (idempotent — already loaded by earlier migrations on
-- the rokibrain-postgres on Scaleway, but re-asserted here so a fresh DB
-- bootstraps without surprise):
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";

-- ─────────────────────────────────────────────────────────────────────
-- device_app_install — physical install of rokibrain.app on a device
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE "device_app_install" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_email"   CITEXT NOT NULL,
    "device_kind"   TEXT NOT NULL,
    "hostname"      TEXT,
    "os_version"    TEXT,
    "app_version"   TEXT,
    "public_key"    TEXT NOT NULL,
    "paired_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "last_seen_at"  TIMESTAMPTZ,
    "revoked_at"    TIMESTAMPTZ,
    CONSTRAINT "device_app_install_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "device_app_install_kind_check"
      CHECK ("device_kind" IN ('mac','linux','windows','ios','android'))
);
CREATE UNIQUE INDEX "device_app_install_owner_pubkey_uq"
  ON "device_app_install"("owner_email","public_key");
CREATE INDEX "ix_device_owner" ON "device_app_install"("owner_email");

-- ─────────────────────────────────────────────────────────────────────
-- mesh_accounts — per-platform paired account
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE "mesh_accounts" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_email"      CITEXT NOT NULL,
    "platform"         TEXT NOT NULL,
    "device_id"        UUID NOT NULL,
    "label"            TEXT NOT NULL,
    "external_id"      TEXT,
    "country_cc"       TEXT,
    "status"           TEXT NOT NULL DEFAULT 'pending',
    "frozen_until"     TIMESTAMPTZ,
    "policy_json"      JSONB NOT NULL DEFAULT '{}'::jsonb,
    "blackout_windows" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "paired_at"        TIMESTAMPTZ,
    "last_active_at"   TIMESTAMPTZ,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "mesh_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mesh_accounts_platform_check"
      CHECK ("platform" IN
        ('whatsapp','telegram','discord','email','linkedin','x',
         'instagram','signal_blocked','sms','slack')),
    CONSTRAINT "mesh_accounts_status_check"
      CHECK ("status" IN
        ('pending','connected','qr_required','disconnected','frozen','banned')),
    CONSTRAINT "mesh_accounts_device_fkey"
      FOREIGN KEY ("device_id") REFERENCES "device_app_install"("id")
      ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "mesh_accounts_platform_extid_uq"
  ON "mesh_accounts"("platform","external_id");
CREATE INDEX "ix_mesh_accounts_owner"  ON "mesh_accounts"("owner_email");
CREATE INDEX "ix_mesh_accounts_device" ON "mesh_accounts"("device_id");

-- ─────────────────────────────────────────────────────────────────────
-- mesh_sessions — encrypted session blob per account
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE "mesh_sessions" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id"    UUID NOT NULL,
    "session_blob"  BYTEA,
    "encrypted_dek" BYTEA NOT NULL,
    "rotated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "mesh_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mesh_sessions_account_fkey"
      FOREIGN KEY ("account_id") REFERENCES "mesh_accounts"("id")
      ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────
-- mesh_contacts — per-account thread / contact
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE "mesh_contacts" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id"    UUID NOT NULL,
    "external_id"   TEXT NOT NULL,
    "display_name"  TEXT,
    "warmed"        BOOLEAN NOT NULL DEFAULT FALSE,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "last_msg_at"   TIMESTAMPTZ,
    CONSTRAINT "mesh_contacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mesh_contacts_account_fkey"
      FOREIGN KEY ("account_id") REFERENCES "mesh_accounts"("id")
      ON DELETE CASCADE
);
CREATE UNIQUE INDEX "mesh_contacts_account_extid_uq"
  ON "mesh_contacts"("account_id","external_id");

-- ─────────────────────────────────────────────────────────────────────
-- mesh_action_log — append-only audit (created BEFORE mesh_messages
-- because mesh_messages.audit_id references it)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE "mesh_action_log" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID,
    "action"     TEXT NOT NULL,
    "payload"    JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "mesh_action_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mesh_action_log_account_fkey"
      FOREIGN KEY ("account_id") REFERENCES "mesh_accounts"("id")
      ON DELETE SET NULL
);
CREATE INDEX "ix_mesh_action_log_account_at"
  ON "mesh_action_log"("account_id","created_at" DESC);

-- ─────────────────────────────────────────────────────────────────────
-- mesh_messages — inbox + outbox rows
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE "mesh_messages" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id"      UUID NOT NULL,
    "contact_id"      UUID,
    "direction"       TEXT NOT NULL,
    "body"            TEXT,
    "body_hash"       TEXT NOT NULL,
    "media_json"      JSONB NOT NULL DEFAULT '[]'::jsonb,
    "external_msg_id" TEXT,
    "ts"              TIMESTAMPTZ NOT NULL,
    "audit_id"        UUID,
    CONSTRAINT "mesh_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mesh_messages_direction_check"
      CHECK ("direction" IN ('in','out')),
    CONSTRAINT "mesh_messages_account_fkey"
      FOREIGN KEY ("account_id") REFERENCES "mesh_accounts"("id")
      ON DELETE CASCADE,
    CONSTRAINT "mesh_messages_contact_fkey"
      FOREIGN KEY ("contact_id") REFERENCES "mesh_contacts"("id")
      ON DELETE SET NULL,
    CONSTRAINT "mesh_messages_audit_fkey"
      FOREIGN KEY ("audit_id") REFERENCES "mesh_action_log"("id")
);
CREATE INDEX "ix_mesh_messages_account_ts"
  ON "mesh_messages"("account_id","ts" DESC);
CREATE INDEX "ix_mesh_messages_contact_ts"
  ON "mesh_messages"("contact_id","ts" DESC);

-- ─────────────────────────────────────────────────────────────────────
-- mesh_counters — anti-ban accounting; UPSERT on (account_id,bucket,bucket_start)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE "mesh_counters" (
    "account_id"   UUID NOT NULL,
    "bucket"       TEXT NOT NULL,
    "bucket_start" TIMESTAMPTZ NOT NULL,
    "count"        INT NOT NULL,
    CONSTRAINT "mesh_counters_pkey"
      PRIMARY KEY ("account_id","bucket","bucket_start"),
    CONSTRAINT "mesh_counters_bucket_check"
      CHECK ("bucket" IN ('minute','hour','day','unwarmed_day','burst_60s')),
    CONSTRAINT "mesh_counters_account_fkey"
      FOREIGN KEY ("account_id") REFERENCES "mesh_accounts"("id")
      ON DELETE CASCADE
);
CREATE INDEX "ix_mesh_counters_purge" ON "mesh_counters"("bucket_start");

-- ─────────────────────────────────────────────────────────────────────
-- mesh_drafts — pending / approved / rejected outbound
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE "mesh_drafts" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id"          UUID NOT NULL,
    "contact_external_id" TEXT NOT NULL,
    "body"                TEXT NOT NULL,
    "persona_slug"        TEXT,
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "approved_at"         TIMESTAMPTZ,
    "approved_by"         TEXT,
    "rejected_at"         TIMESTAMPTZ,
    "rejected_by"         TEXT,
    "refused_reasons"     JSONB,
    "similarity_score"    NUMERIC(4,3),
    CONSTRAINT "mesh_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mesh_drafts_account_fkey"
      FOREIGN KEY ("account_id") REFERENCES "mesh_accounts"("id")
      ON DELETE CASCADE
);
-- Partial index for the "pending drafts" hot path (mirrors design §4).
-- Prisma can't express WHERE-filtered indexes today, so it lives in raw SQL only.
CREATE INDEX "ix_mesh_drafts_pending"
  ON "mesh_drafts"("account_id")
  WHERE "approved_at" IS NULL AND "rejected_at" IS NULL;
CREATE INDEX "ix_mesh_drafts_account" ON "mesh_drafts"("account_id");
