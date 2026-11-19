-- Tasks parity: work timers, progress revisions and history, date-only deadlines,
-- file types, and assignment attachments.
ALTER TABLE "tasks" ADD COLUMN "state_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "tracked_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_client_reported_at" TIMESTAMPTZ(3),
ADD COLUMN "due_date_only" BOOLEAN NOT NULL DEFAULT false;

-- Existing files get their type on the next sync.
ALTER TABLE "files" ADD COLUMN "detected_type" TEXT NOT NULL DEFAULT 'other',
ADD COLUMN "user_override_type" TEXT;

CREATE TABLE "task_work_sessions" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "duration_seconds" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'timer',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_work_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "task_work_sessions_task_id_started_at_idx" ON "task_work_sessions"("task_id", "started_at");

CREATE INDEX "task_work_sessions_user_id_ended_at_idx" ON "task_work_sessions"("user_id", "ended_at");

-- At most one running timer per user (Prisma can't declare partial indexes).
CREATE UNIQUE INDEX "task_work_sessions_one_open_per_user" ON "task_work_sessions"("user_id") WHERE "ended_at" IS NULL;

ALTER TABLE "task_work_sessions" ADD CONSTRAINT "task_work_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_work_sessions" ADD CONSTRAINT "task_work_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "task_progress" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" INTEGER NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "progress" INTEGER NOT NULL,
    "completed" BOOLEAN NOT NULL,
    "origin" TEXT NOT NULL,

    CONSTRAINT "task_progress_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "task_progress_task_id_recorded_at_idx" ON "task_progress"("task_id", "recorded_at");

CREATE INDEX "task_progress_user_id_idx" ON "task_progress"("user_id");

ALTER TABLE "task_progress" ADD CONSTRAINT "task_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_progress" ADD CONSTRAINT "task_progress_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "task_file_links" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" INTEGER NOT NULL,
    "file_canvas_id" TEXT NOT NULL,

    CONSTRAINT "task_file_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_file_links_task_id_file_canvas_id_key" ON "task_file_links"("task_id", "file_canvas_id");

CREATE INDEX "task_file_links_user_id_idx" ON "task_file_links"("user_id");

ALTER TABLE "task_file_links" ADD CONSTRAINT "task_file_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_file_links" ADD CONSTRAINT "task_file_links_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
