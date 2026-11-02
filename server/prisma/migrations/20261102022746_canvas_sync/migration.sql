-- CreateEnum
CREATE TYPE "connection_status" AS ENUM ('OK', 'TOKEN_REJECTED');

-- CreateEnum
CREATE TYPE "sync_trigger" AS ENUM ('CONNECT', 'MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "sync_status" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "item_kind" AS ENUM ('ASSIGNMENT', 'FILE', 'ANNOUNCEMENT');

-- CreateEnum
CREATE TYPE "change_type" AS ENUM ('CREATED', 'UPDATED', 'REMOVED');

-- CreateTable
CREATE TABLE "canvas_connections" (
    "user_id" UUID NOT NULL,
    "base_url" TEXT NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    "canvas_user_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "connection_status" NOT NULL DEFAULT 'OK',
    "verified_at" TIMESTAMPTZ(3) NOT NULL,
    "sync_lease_until" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "canvas_connections_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trigger" "sync_trigger" NOT NULL,
    "status" "sync_status" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "courses_synced" INTEGER NOT NULL DEFAULT 0,
    "changes_detected" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "canvas_id" TEXT NOT NULL,
    "course_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "term_name" TEXT,
    "term_start_at" TIMESTAMPTZ(3),
    "term_end_at" TIMESTAMPTZ(3),
    "html_url" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" INTEGER NOT NULL,
    "canvas_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "due_at" TIMESTAMPTZ(3),
    "points_possible" DOUBLE PRECISION,
    "html_url" TEXT,
    "submission_state" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "ignored_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" INTEGER NOT NULL,
    "canvas_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "content_type" TEXT,
    "size_bytes" INTEGER NOT NULL,
    "canvas_updated_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_items" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" INTEGER NOT NULL,
    "kind" "item_kind" NOT NULL,
    "canvas_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "html_url" TEXT,
    "content_hash" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "source_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_events" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" INTEGER NOT NULL,
    "source_item_id" INTEGER NOT NULL,
    "change_type" "change_type" NOT NULL,
    "fields" TEXT[],
    "summary" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "change_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "canvas_connections_last_synced_at_idx" ON "canvas_connections"("last_synced_at");

-- CreateIndex
CREATE INDEX "sync_runs_user_id_started_at_idx" ON "sync_runs"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "courses_user_id_archived_at_idx" ON "courses"("user_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "courses_user_id_canvas_id_key" ON "courses"("user_id", "canvas_id");

-- CreateIndex
CREATE INDEX "tasks_user_id_due_at_idx" ON "tasks"("user_id", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_course_id_canvas_id_key" ON "tasks"("course_id", "canvas_id");

-- CreateIndex
CREATE INDEX "files_user_id_course_id_idx" ON "files"("user_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "files_course_id_canvas_id_key" ON "files"("course_id", "canvas_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_items_course_id_kind_canvas_id_key" ON "source_items"("course_id", "kind", "canvas_id");

-- CreateIndex
CREATE INDEX "change_events_user_id_detected_at_idx" ON "change_events"("user_id", "detected_at");

-- CreateIndex
CREATE INDEX "change_events_user_id_read_at_idx" ON "change_events"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "change_events_course_id_detected_at_idx" ON "change_events"("course_id", "detected_at");

-- AddForeignKey
ALTER TABLE "canvas_connections" ADD CONSTRAINT "canvas_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "source_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
