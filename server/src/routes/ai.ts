import { Router } from "express";
import { z } from "zod";
import { chatTurn } from "../ai/chat.js";
import { historyFor, openConversation, presentConfirmation, presentConversation, saveMessage } from "../ai/conversations.js";
import { AiError } from "../ai/provider.js";
import { aiProviderFor } from "../ai/resolve.js";
import { CONFIRMATION_TTL_MS, applyWrite, problemText } from "../ai/writeTools.js";
import { currentAuth } from "../auth/middleware.js";
import { enforce } from "../auth/throttle.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam } from "../http/params.js";
import { isPreview } from "../preview/accounts.js";
import type { Services } from "../services.js";
import { getSettings } from "./settings.js";

const MINUTE = 60_000;
/** Each turn can mean several paid calls to the provider, and previews share one key. */
export const AI_TURNS_PER_ACCOUNT = { limit: 30, windowMs: 10 * MINUTE };
export const AI_TURNS_PER_NETWORK = { limit: 120, windowMs: 10 * MINUTE };

const chatRequest = z
  .object({
    /** The conversation to continue; a missing or unknown one starts a new conversation. */
    conversation_id: z.uuid().nullable().default(null),
    message: z.string({ error: "Write a message." }).trim().min(1, "Write a message.").max(8000, "Use at most 8,000 characters."),
    page: z
      .object({ path: z.string().max(200).default("/"), course_id: z.number().int().positive().nullable().default(null) })
      .strict()
      .default({ path: "/", course_id: null }),
  })
  .strict();

const confirmRequest = z
  .object({
    confirmation_id: z.uuid({ error: "That confirmation could not be found." }),
    action: z.enum(["confirm", "cancel"], { error: "Send confirm or cancel." }),
  })
  .strict();

const disabled = () => new HttpError(503, "AI_DISABLED", "AI Chat is not set up. Add an AI provider in Settings.");
const confirmationNotFound = () => new HttpError(404, "CONFIRMATION_NOT_FOUND", "That confirmation could not be found.");
const conversationNotFound = () => new HttpError(404, "CONVERSATION_NOT_FOUND", "That conversation could not be found.");
const taskNotFound = () => new HttpError(404, "TASK_NOT_FOUND", "That task could not be found.");

const AI_ERRORS: Record<AiError["kind"], { status: number; code: string }> = {
  auth: { status: 502, code: "AI_AUTH_FAILED" },
  rate_limited: { status: 503, code: "AI_RATE_LIMITED" },
  bad_request: { status: 502, code: "AI_BAD_REQUEST" },
  not_found: { status: 502, code: "AI_MODEL_NOT_FOUND" },
  unavailable: { status: 503, code: "AI_UNAVAILABLE" },
  bad_reply: { status: 502, code: "AI_BAD_REPLY" },
};

export function aiRouter(db: Db, services: Services): Router {
  const router = Router();

  /** Whether AI is available to this user, and from where: their own connection or the server's. */
  router.get("/", async (_req, res) => {
    const { user } = currentAuth(res.locals);
    const provider = await aiProviderFor(db, services, user.id);
    res.json({ enabled: provider !== null, model: provider?.model ?? null, source: provider ? (provider === services.ai ? "server" : "own") : null });
  });

  /**
   * One turn of a stored conversation: the model reads what it needs and answers, or proposes one
   * change, which waits as a confirmation until the student decides.
   */
  router.post("/chat", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const body = chatRequest.parse(req.body ?? {});
    const provider = await aiProviderFor(db, services, user.id);
    if (!provider) throw disabled();
    await enforce(
      db,
      [
        { key: `ai:${user.id}`, ...AI_TURNS_PER_ACCOUNT },
        { key: `ai-net:${req.ip}`, ...AI_TURNS_PER_NETWORK },
      ],
      "You've sent a lot of messages to AI Chat. Try again in a few minutes.",
    );
    const settings = await getSettings(db, user.id);
    const conversationId = await openConversation(db, user.id, body.conversation_id);
    const messageId = await saveMessage(db, conversationId, { role: "user", content: body.message });
    const now = new Date();
    const ctx = { db, services, userId: user.id, preview: isPreview(user), timeZone: settings.timeZone, now };
    let result;
    try {
      result = await chatTurn(provider, ctx, {
        history: await historyFor(db, conversationId),
        page: { path: body.page.path, courseId: body.page.course_id },
      });
    } catch (error) {
      // Not kept, so "Try again" sends the same message without a duplicate.
      await db.aiChatMessage.deleteMany({ where: { id: messageId } });
      if (!(error instanceof AiError)) throw error;
      const { status, code } = AI_ERRORS[error.kind];
      throw new HttpError(status, code, error.message);
    }
    const evidence = result.evidence;
    if (result.message) {
      await saveMessage(db, conversationId, { role: "assistant", content: result.message, payload: evidence.length ? { evidence } : undefined });
    }
    let confirmation = null;
    if (result.proposal) {
      const row = await db.aiConfirmation.create({
        data: {
          userId: user.id,
          conversationId,
          toolName: result.proposal.toolName,
          arguments: result.proposal.arguments as Prisma.InputJsonValue,
          summary: result.proposal.summary,
          details: result.proposal.details as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
        },
      });
      confirmation = presentConfirmation(row, now);
      await saveMessage(db, conversationId, {
        role: "assistant",
        kind: "confirmation",
        content: row.summary,
        toolName: row.toolName,
        payload: { confirmation_id: row.id },
      });
    }
    res.json({ conversation_id: conversationId, message: result.message, tool_results: evidence, confirmation, tools_used: result.tools_used });
  });

  router.get("/chat/conversations/:id", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw conversationNotFound();
    const conversation = await presentConversation(db, user.id, id.data);
    if (!conversation) throw conversationNotFound();
    res.json(conversation);
  });

  /** Applies or cancels a proposed change. Only its owner can, only once, and only before it expires. */
  router.post("/chat/confirm", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const body = confirmRequest.parse(req.body ?? {});
    const now = new Date();
    const row = await db.aiConfirmation.findFirst({ where: { id: body.confirmation_id, userId: user.id } });
    if (!row) throw confirmationNotFound();
    if (row.status !== "PENDING") throw new HttpError(409, "CONFIRMATION_ALREADY_RESOLVED", "This change was already confirmed or cancelled.");
    if (row.expiresAt <= now) {
      await db.aiConfirmation.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "EXPIRED", resolvedAt: now } });
      throw new HttpError(410, "CONFIRMATION_EXPIRED", "This proposal expired. Ask AI Chat again.");
    }
    // Claiming the row first means two clicks can never apply it twice.
    const claimed = await db.aiConfirmation.updateMany({
      where: { id: row.id, userId: user.id, status: "PENDING" },
      data: { status: body.action === "cancel" ? "CANCELLED" : "APPLYING", resolvedAt: now },
    });
    if (!claimed.count) throw new HttpError(409, "CONFIRMATION_ALREADY_RESOLVED", "This change was already confirmed or cancelled.");

    let status = "CANCELLED";
    let result: Record<string, unknown> = { cancelled: true };
    if (body.action === "confirm") {
      const settings = await getSettings(db, user.id);
      try {
        result = await applyWrite(row.toolName, row.arguments, { db, userId: user.id, timeZone: settings.timeZone, now });
        status = "APPLIED";
      } catch (error) {
        const problem = problemText(error);
        await db.aiConfirmation.update({ where: { id: row.id }, data: { status: "FAILED", result: { error: problem ?? "Something went wrong." } } });
        if (problem === null) throw error;
        status = "FAILED";
        result = { error: problem };
      }
      if (status === "APPLIED") await db.aiConfirmation.update({ where: { id: row.id }, data: { status, result: result as Prisma.InputJsonValue } });
    }
    const message = status === "APPLIED" ? "Change applied." : status === "CANCELLED" ? "Change cancelled." : `Not applied: ${result.error as string}`;
    await saveMessage(db, row.conversationId, {
      role: "assistant",
      kind: "mutation_result",
      content: `${row.summary}: ${message}`,
      toolName: row.toolName,
      payload: { confirmation_id: row.id },
    });
    const fresh = await db.aiConfirmation.findUniqueOrThrow({ where: { id: row.id } });
    res.json({ conversation_id: row.conversationId, confirmation: presentConfirmation(fresh, now), message });
  });

  /** The AI summary of a Canvas assignment's description for the task card; made in the background. */
  router.get("/tasks/:id/summary", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const task = await db.task.findFirst({ where: { id: idParam(req.params.id, taskNotFound()), userId: user.id } });
    if (!task) throw taskNotFound();
    res.json(await services.aiJobs.summaryState(user.id, task));
  });

  return router;
}
