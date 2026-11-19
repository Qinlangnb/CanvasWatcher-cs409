-- Important Changes parity: change taxonomy and dedupe, AI change review, noise filters,
-- notification banners and Canvas grading policy. Additive only.
ALTER TABLE "change_events" ADD COLUMN     "ai_summary" TEXT,
ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'content',
ADD COLUMN     "importance" TEXT NOT NULL DEFAULT 'minor',
ADD COLUMN     "requires_action" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "semantic_key" TEXT,
ADD COLUMN     "user_facing" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "change_reviews" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "change_event_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "stage1" TEXT NOT NULL,
    "stage1_reason" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "matched_rule" JSONB,
    "notify_user" BOOLEAN NOT NULL DEFAULT false,
    "severity" TEXT,
    "reason" TEXT,
    "recommended_action" TEXT,
    "rule_feedback" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "change_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_filter_rules" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "identity_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "rule" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "match_count" INTEGER NOT NULL DEFAULT 0,
    "last_matched_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "change_filter_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_filter_audits" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "rule_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_filter_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "change_event_id" INTEGER,
    "level" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "dismissed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_policies" (
    "course_id" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "weighted" BOOLEAN NOT NULL,
    "groups" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_policies_pkey" PRIMARY KEY ("course_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "change_reviews_change_event_id_key" ON "change_reviews"("change_event_id");

-- CreateIndex
CREATE INDEX "change_reviews_status_updated_at_idx" ON "change_reviews"("status", "updated_at");

-- CreateIndex
CREATE INDEX "change_reviews_user_id_status_idx" ON "change_reviews"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "change_filter_rules_user_id_identity_key_key" ON "change_filter_rules"("user_id", "identity_key");

-- CreateIndex
CREATE INDEX "change_filter_audits_rule_id_id_idx" ON "change_filter_audits"("rule_id", "id");

-- CreateIndex
CREATE INDEX "change_filter_audits_user_id_idx" ON "change_filter_audits"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_dismissed_at_idx" ON "notifications"("user_id", "dismissed_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "course_policies_user_id_idx" ON "course_policies"("user_id");

-- CreateIndex
CREATE INDEX "change_events_user_id_user_facing_read_at_idx" ON "change_events"("user_id", "user_facing", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "change_events_user_id_semantic_key_key" ON "change_events"("user_id", "semantic_key");

-- AddForeignKey
ALTER TABLE "change_reviews" ADD CONSTRAINT "change_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_reviews" ADD CONSTRAINT "change_reviews_change_event_id_fkey" FOREIGN KEY ("change_event_id") REFERENCES "change_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_filter_rules" ADD CONSTRAINT "change_filter_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_filter_audits" ADD CONSTRAINT "change_filter_audits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_filter_audits" ADD CONSTRAINT "change_filter_audits_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "change_filter_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_change_event_id_fkey" FOREIGN KEY ("change_event_id") REFERENCES "change_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_policies" ADD CONSTRAINT "course_policies_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_policies" ADD CONSTRAINT "course_policies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing changes get the taxonomy the sync now records (see changes/taxonomy.ts). Older rows keep no semantic key.
UPDATE "change_events" AS c SET
    "category" = CASE
        WHEN s."kind" = 'FILE' THEN 'file'
        WHEN s."kind" = 'ANNOUNCEMENT' THEN 'announcement'
        WHEN c."change_type" = 'UPDATED' AND c."fields" && ARRAY['due_at', 'lock_at'] THEN 'deadline'
        ELSE 'assignment'
    END,
    "importance" = CASE
        WHEN s."kind" = 'ASSIGNMENT' AND c."change_type" = 'UPDATED' AND c."fields" && ARRAY['due_at', 'lock_at'] THEN 'important'
        ELSE 'minor'
    END,
    "requires_action" = (s."kind" = 'ASSIGNMENT' AND c."change_type" = 'UPDATED' AND c."fields" && ARRAY['due_at', 'lock_at']),
    "user_facing" = (
        (s."kind" IN ('FILE', 'ANNOUNCEMENT') AND c."change_type" = 'CREATED')
        OR (s."kind" = 'ASSIGNMENT' AND c."change_type" = 'UPDATED' AND c."fields" && ARRAY['due_at', 'lock_at'])
    )
FROM "source_items" AS s
WHERE s."id" = c."source_item_id";
