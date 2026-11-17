-- Used time, Canvas scores, and a kept copy of each course's syllabus.
ALTER TABLE "tasks" ADD COLUMN "spent_minutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "score" DOUBLE PRECISION,
ADD COLUMN "grade" TEXT,
ADD COLUMN "excused" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "course_syllabi" (
    "course_id" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_syllabi_pkey" PRIMARY KEY ("course_id")
);

CREATE INDEX "course_syllabi_user_id_idx" ON "course_syllabi"("user_id");

ALTER TABLE "course_syllabi" ADD CONSTRAINT "course_syllabi_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_syllabi" ADD CONSTRAINT "course_syllabi_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
