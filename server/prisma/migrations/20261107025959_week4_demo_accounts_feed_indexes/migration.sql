-- DropIndex
DROP INDEX "change_events_course_id_detected_at_idx";

-- DropIndex
DROP INDEX "change_events_user_id_detected_at_idx";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "demo_expires_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "change_events_user_id_id_idx" ON "change_events"("user_id", "id");

-- CreateIndex
CREATE INDEX "change_events_course_id_id_idx" ON "change_events"("course_id", "id");

-- CreateIndex
CREATE INDEX "users_demo_expires_at_idx" ON "users"("demo_expires_at");
