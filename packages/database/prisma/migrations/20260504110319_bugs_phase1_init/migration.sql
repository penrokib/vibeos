-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('P0', 'P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "BugStatus" AS ENUM ('OPEN', 'CLAIMED', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'CLOSED', 'WONT_FIX', 'DUPLICATE');

-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apps" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "repo_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_features" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "howto" TEXT NOT NULL,
    "tags" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bugs" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "Severity" NOT NULL DEFAULT 'P2',
    "status" "BugStatus" NOT NULL DEFAULT 'OPEN',
    "app_id" UUID NOT NULL,
    "feature_id" UUID,
    "reporter" TEXT NOT NULL,
    "reporter_name" TEXT,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "fixed_at" TIMESTAMP(3),
    "fix_commit_sha" TEXT,
    "fix_branch" TEXT,
    "verified_by" TEXT,
    "verified_at" TIMESTAMP(3),
    "console_log" TEXT,
    "network_errors" TEXT,
    "screenshot_url" TEXT,
    "video_url" TEXT,
    "url" TEXT,
    "user_agent" TEXT,
    "viewport_size" TEXT,

    CONSTRAINT "bugs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bug_comments" (
    "id" UUID NOT NULL,
    "bug_id" UUID NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bug_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decisions_status_created_at_idx" ON "decisions"("status", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_created_at_idx" ON "audit_events"("actor", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "apps_slug_key" ON "apps"("slug");

-- CreateIndex
CREATE INDEX "app_features_app_id_idx" ON "app_features"("app_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_features_app_id_slug_key" ON "app_features"("app_id", "slug");

-- CreateIndex
CREATE INDEX "bugs_status_reported_at_idx" ON "bugs"("status", "reported_at");

-- CreateIndex
CREATE INDEX "bugs_app_id_status_idx" ON "bugs"("app_id", "status");

-- CreateIndex
CREATE INDEX "bugs_severity_status_idx" ON "bugs"("severity", "status");

-- CreateIndex
CREATE INDEX "bug_comments_bug_id_created_at_idx" ON "bug_comments"("bug_id", "created_at");

-- AddForeignKey
ALTER TABLE "app_features" ADD CONSTRAINT "app_features_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "app_features"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bug_comments" ADD CONSTRAINT "bug_comments_bug_id_fkey" FOREIGN KEY ("bug_id") REFERENCES "bugs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
