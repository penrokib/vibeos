-- Brain-native: devices + terminal sessions
-- See plans/yeah-so-whatever-we-humming-torvalds.md (Phase A).

CREATE TABLE "devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_email" TEXT NOT NULL,
    "device_kind" TEXT NOT NULL,
    "public_key" TEXT,
    "paired_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "last_seen_at" TIMESTAMPTZ,
    CONSTRAINT "devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "devices_device_kind_check" CHECK ("device_kind" IN ('ios','macos','m3-bridge'))
);

CREATE INDEX "idx_devices_owner" ON "devices"("owner_email");

CREATE TABLE "terminal_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" UUID NOT NULL,
    "session_name" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "ended_at" TIMESTAMPTZ,
    CONSTRAINT "terminal_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "terminal_sessions_device_id_fkey"
      FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE
);

CREATE INDEX "idx_terminal_sessions_device" ON "terminal_sessions"("device_id");
