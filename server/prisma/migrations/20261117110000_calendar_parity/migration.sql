-- Calendar parity: study availability, course commute, richer manual events and re-importable .ics sources.
ALTER TABLE "courses" ADD COLUMN "commute_minutes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "calendar_sources" ADD COLUMN "file_sha256" TEXT,
ADD COLUMN "time_zone" TEXT,
ADD COLUMN "recurring_series_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_reimported_at" TIMESTAMPTZ(3);

ALTER TABLE "calendar_events" ADD COLUMN "description" TEXT,
ADD COLUMN "time_zone" TEXT,
ADD COLUMN "event_type" TEXT NOT NULL DEFAULT 'other',
ADD COLUMN "course_id" INTEGER,
ADD COLUMN "recurrence_rule" TEXT,
ADD COLUMN "external_id" TEXT;

CREATE UNIQUE INDEX "calendar_events_source_id_external_id_key" ON "calendar_events"("source_id", "external_id");

CREATE INDEX "calendar_events_course_id_idx" ON "calendar_events"("course_id");

ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "study_availability_rules" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "study_availability_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "study_availability_rules_user_id_idx" ON "study_availability_rules"("user_id");

ALTER TABLE "study_availability_rules" ADD CONSTRAINT "study_availability_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "study_availability_overrides" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "intervals" JSONB NOT NULL,

    CONSTRAINT "study_availability_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "study_availability_overrides_user_id_date_key" ON "study_availability_overrides"("user_id", "date");

ALTER TABLE "study_availability_overrides" ADD CONSTRAINT "study_availability_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
