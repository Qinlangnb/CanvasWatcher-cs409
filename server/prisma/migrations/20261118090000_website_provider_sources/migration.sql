-- Course websites (public or NTLM) and read-only Gradescope / PrairieLearn sources: website-owned
-- courses, website files with their bytes, pages, pending resources, provider course maps and facts.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "task_source" ADD VALUE 'WEBSITE';
ALTER TYPE "task_source" ADD VALUE 'GRADESCOPE';

-- AlterEnum
ALTER TYPE "item_kind" ADD VALUE 'PAGE';

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "owner_source_id" UUID,
ADD COLUMN     "source" "source_type" NOT NULL DEFAULT 'CANVAS';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "external_tool_url" TEXT,
ADD COLUMN     "source_id" UUID;

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "blob_id" INTEGER,
ADD COLUMN     "integrity_status" TEXT,
ADD COLUMN     "sha256" VARCHAR(64),
ADD COLUMN     "source_id" UUID,
ADD COLUMN     "source_url" TEXT,
ADD COLUMN     "validation_error" TEXT;

-- AlterTable
ALTER TABLE "source_items" ADD COLUMN     "source_id" UUID;

-- CreateTable
CREATE TABLE "website_credentials" (
    "connection_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "password_ciphertext" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "state" "credential_state" NOT NULL DEFAULT 'MISSING',
    "verified_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "website_credentials_pkey" PRIMARY KEY ("connection_id")
);

-- CreateTable
CREATE TABLE "website_pages" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "course_id" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "website_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_blobs" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_resources" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "item_type" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "last_error_code" TEXT,
    "discovered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pending_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_course_maps" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "provider_course_id" TEXT NOT NULL,
    "course_id" INTEGER NOT NULL,
    "course_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_course_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_assignments" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "course_id" INTEGER NOT NULL,
    "provider_course_id" TEXT NOT NULL,
    "provider_assignment_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "task_id" INTEGER,
    "binding" TEXT,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "provider_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "website_credentials_user_id_idx" ON "website_credentials"("user_id");

-- CreateIndex
CREATE INDEX "website_pages_user_id_course_id_idx" ON "website_pages"("user_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "website_pages_source_id_url_key" ON "website_pages"("source_id", "url");

-- CreateIndex
CREATE UNIQUE INDEX "website_blobs_user_id_sha256_key" ON "website_blobs"("user_id", "sha256");

-- CreateIndex
CREATE INDEX "pending_resources_user_id_idx" ON "pending_resources"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_resources_source_id_url_key" ON "pending_resources"("source_id", "url");

-- CreateIndex
CREATE INDEX "provider_course_maps_user_id_idx" ON "provider_course_maps"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_course_maps_source_id_provider_course_id_key" ON "provider_course_maps"("source_id", "provider_course_id");

-- CreateIndex
CREATE INDEX "provider_assignments_user_id_task_id_idx" ON "provider_assignments"("user_id", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_assignments_source_id_provider_course_id_provider__key" ON "provider_assignments"("source_id", "provider_course_id", "provider_assignment_id");

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_owner_source_id_fkey" FOREIGN KEY ("owner_source_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_blob_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "website_blobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_credentials" ADD CONSTRAINT "website_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_pages" ADD CONSTRAINT "website_pages_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_pages" ADD CONSTRAINT "website_pages_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_blobs" ADD CONSTRAINT "website_blobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_resources" ADD CONSTRAINT "pending_resources_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_course_maps" ADD CONSTRAINT "provider_course_maps_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_course_maps" ADD CONSTRAINT "provider_course_maps_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
