-- Course website files: remember ETag / Last-Modified and the last full download, so syncs re-check
-- stored files conditionally instead of downloading every file again.
ALTER TABLE "files" ADD COLUMN "source_etag" TEXT,
ADD COLUMN "source_last_modified" TEXT,
ADD COLUMN "source_fetched_at" TIMESTAMPTZ(3);
