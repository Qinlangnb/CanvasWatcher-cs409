-- Sources: per-user source connections, Canvas credential slots (PAT, browser session, OAuth),
-- provider sessions, Auth Broker challenges and OAuth states. Additive; existing data is kept.
-- CreateEnum
CREATE TYPE "source_type" AS ENUM ('CANVAS', 'WEBSITE', 'GRADESCOPE', 'PRAIRIELEARN');

-- CreateEnum
CREATE TYPE "source_health" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'AUTH_REQUIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "canvas_auth_method" AS ENUM ('PAT', 'BROWSER_SESSION', 'OAUTH');

-- CreateEnum
CREATE TYPE "credential_state" AS ENUM ('MISSING', 'VALID', 'INVALID', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "challenge_state" AS ENUM ('WAITING_FOR_USER', 'LOGIN_OPENED', 'AUTHENTICATED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- AlterTable
ALTER TABLE "canvas_connections" ADD COLUMN     "fallback" JSONB,
ADD COLUMN     "preferred_method" "canvas_auth_method",
ALTER COLUMN "token_ciphertext" DROP NOT NULL;

-- CreateTable
CREATE TABLE "source_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "source_type" NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "course_id" INTEGER,
    "config" JSONB NOT NULL DEFAULT '{}',
    "state" TEXT NOT NULL DEFAULT 'READY',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_sync_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "health" "source_health" NOT NULL DEFAULT 'UNKNOWN',
    "health_summary" TEXT,
    "diagnostics" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "source_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canvas_credentials" (
    "user_id" UUID NOT NULL,
    "method" "canvas_auth_method" NOT NULL,
    "secret_ciphertext" TEXT,
    "legacy_aad" BOOLEAN NOT NULL DEFAULT false,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "state" "credential_state" NOT NULL DEFAULT 'MISSING',
    "verified_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    "account_fingerprint" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "expiration_source" TEXT,
    "notified_state" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "canvas_credentials_pkey" PRIMARY KEY ("user_id","method")
);

-- CreateTable
CREATE TABLE "provider_sessions" (
    "connection_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "cookie_ciphertext" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "state" "credential_state" NOT NULL DEFAULT 'MISSING',
    "verified_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_sessions_pkey" PRIMARY KEY ("connection_id")
);

-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "ticket_hash" TEXT NOT NULL,
    "control_hash" TEXT NOT NULL,
    "exchange_hash" TEXT,
    "state" "challenge_state" NOT NULL DEFAULT 'WAITING_FOR_USER',
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "finishing" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "deadline" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canvas_oauth_states" (
    "state_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "base_url" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "canvas_oauth_states_pkey" PRIMARY KEY ("state_hash")
);

-- CreateIndex
CREATE INDEX "source_connections_user_id_idx" ON "source_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_connections_user_id_type_base_url_key" ON "source_connections"("user_id", "type", "base_url");

-- CreateIndex
CREATE INDEX "provider_sessions_user_id_idx" ON "provider_sessions"("user_id");

-- CreateIndex
CREATE INDEX "auth_challenges_user_id_idx" ON "auth_challenges"("user_id");

-- CreateIndex
CREATE INDEX "auth_challenges_deadline_idx" ON "auth_challenges"("deadline");

-- CreateIndex
CREATE INDEX "canvas_oauth_states_user_id_idx" ON "canvas_oauth_states"("user_id");

-- CreateIndex
CREATE INDEX "canvas_oauth_states_expires_at_idx" ON "canvas_oauth_states"("expires_at");

-- AddForeignKey
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canvas_credentials" ADD CONSTRAINT "canvas_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_sessions" ADD CONSTRAINT "provider_sessions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_sessions" ADD CONSTRAINT "provider_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canvas_oauth_states" ADD CONSTRAINT "canvas_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Every existing Canvas connection becomes the user's Canvas source.
INSERT INTO "source_connections" ("id", "user_id", "type", "name", "base_url", "state", "last_sync_at", "last_success_at", "health", "updated_at")
SELECT gen_random_uuid(), c."user_id", 'CANVAS', 'Canvas', c."base_url",
       CASE c."status" WHEN 'OK' THEN 'READY' ELSE 'AUTH_REQUIRED' END,
       c."last_synced_at", c."last_synced_at",
       CASE c."status" WHEN 'OK' THEN 'UNKNOWN'::"source_health" ELSE 'AUTH_REQUIRED'::"source_health" END,
       CURRENT_TIMESTAMP
FROM "canvas_connections" c;

-- The stored PAT becomes the PAT slot, so nobody has to reconnect. It was sealed with AAD = user id
-- (legacy_aad); the server re-seals it with the slot's AAD the first time it opens it. Preview
-- accounts have no token, and a token Canvas already rejected is recorded as an invalid slot.
INSERT INTO "canvas_credentials" ("user_id", "method", "secret_ciphertext", "legacy_aad", "generation", "state",
                                  "verified_at", "failed_at", "failure_reason", "account_fingerprint", "expiration_source", "updated_at")
SELECT c."user_id", 'PAT',
       CASE c."status" WHEN 'OK' THEN c."token_ciphertext" END,
       c."status" = 'OK', 1,
       CASE c."status" WHEN 'OK' THEN 'VALID'::"credential_state" ELSE 'INVALID'::"credential_state" END,
       c."verified_at",
       CASE c."status" WHEN 'OK' THEN NULL ELSE CURRENT_TIMESTAMP END,
       CASE c."status" WHEN 'OK' THEN NULL ELSE 'TOKEN_REJECTED' END,
       encode(sha256(convert_to(c."base_url" || '|' || c."canvas_user_id", 'UTF8')), 'hex'),
       'UNKNOWN', CURRENT_TIMESTAMP
FROM "canvas_connections" c
JOIN "users" u ON u."id" = c."user_id"
WHERE u."demo_expires_at" IS NULL AND c."token_ciphertext" LIKE 'v1.%';
