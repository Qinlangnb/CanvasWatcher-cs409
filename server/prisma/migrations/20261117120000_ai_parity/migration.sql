-- AI parity: per-user AI connection, stored AI Chat conversations and confirmations, task summaries and estimates.
-- CreateTable
CREATE TABLE "ai_connections" (
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL DEFAULT '',
    "key_ciphertext" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "verified_generation" INTEGER,
    "verified_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_connections_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chat_messages" (
    "id" SERIAL NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "content" TEXT NOT NULL,
    "tool_name" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_confirmations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_ai_summaries" (
    "task_id" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "input_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_ai_summaries_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "task_ai_estimates" (
    "task_id" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "input_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "minutes" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_ai_estimates_pkey" PRIMARY KEY ("task_id")
);

-- CreateIndex
CREATE INDEX "ai_conversations_user_id_updated_at_idx" ON "ai_conversations"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "ai_chat_messages_conversation_id_id_idx" ON "ai_chat_messages"("conversation_id", "id");

-- CreateIndex
CREATE INDEX "ai_confirmations_user_id_status_idx" ON "ai_confirmations"("user_id", "status");

-- CreateIndex
CREATE INDEX "ai_confirmations_conversation_id_idx" ON "ai_confirmations"("conversation_id");

-- CreateIndex
CREATE INDEX "task_ai_summaries_user_id_idx" ON "task_ai_summaries"("user_id");

-- CreateIndex
CREATE INDEX "task_ai_estimates_user_id_idx" ON "task_ai_estimates"("user_id");

-- AddForeignKey
ALTER TABLE "ai_connections" ADD CONSTRAINT "ai_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_confirmations" ADD CONSTRAINT "ai_confirmations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_confirmations" ADD CONSTRAINT "ai_confirmations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_ai_summaries" ADD CONSTRAINT "task_ai_summaries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_ai_summaries" ADD CONSTRAINT "task_ai_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_ai_estimates" ADD CONSTRAINT "task_ai_estimates_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_ai_estimates" ADD CONSTRAINT "task_ai_estimates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

