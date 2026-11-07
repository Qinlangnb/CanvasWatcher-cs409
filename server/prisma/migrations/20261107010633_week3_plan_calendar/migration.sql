-- CreateEnum
CREATE TYPE "task_source" AS ENUM ('CANVAS', 'PERSONAL');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "estimated_minutes" INTEGER,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "source" "task_source" NOT NULL DEFAULT 'CANVAS',
ALTER COLUMN "canvas_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "time_zone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "daily_study_minutes" INTEGER NOT NULL DEFAULT 180,
    "study_start_minute" INTEGER NOT NULL DEFAULT 540,
    "study_end_minute" INTEGER NOT NULL DEFAULT 1320,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "calendar_sources" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "file_name" TEXT,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "source_id" INTEGER,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "busy" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_sources_user_id_idx" ON "calendar_sources"("user_id");

-- CreateIndex
CREATE INDEX "calendar_events_user_id_start_at_idx" ON "calendar_events"("user_id", "start_at");

-- CreateIndex
CREATE INDEX "calendar_events_source_id_idx" ON "calendar_events"("source_id");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_sources" ADD CONSTRAINT "calendar_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "calendar_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
