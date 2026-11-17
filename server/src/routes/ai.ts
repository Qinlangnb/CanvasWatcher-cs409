import { Router } from "express";
import { z } from "zod";
import { AiError } from "../ai/provider.js";
import { chatTurn } from "../ai/chat.js";
import { currentAuth } from "../auth/middleware.js";
import { enforce } from "../auth/throttle.js";
import type { Db } from "../db.js";
import { HttpError } from "../http/errors.js";
import { isPreview } from "../preview/accounts.js";
import type { Services } from "../services.js";
import { getSettings } from "./settings.js";

const MINUTE = 60_000;
/** Each turn can mean several paid calls to the provider, and previews share one key. */
export const AI_TURNS_PER_ACCOUNT = { limit: 30, windowMs: 10 * MINUTE };
export const AI_TURNS_PER_NETWORK = { limit: 120, windowMs: 10 * MINUTE };

const chatRequest = z
  .object({
    /** The conversation so far, oldest first, ending with the student's new message. The browser keeps it. */
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000) }).strict())
      .min(1)
      .max(40)
      .refine((messages) => messages[messages.length - 1]?.role === "user", "The last message must be the student's."),
    page: z
      .object({ path: z.string().max(200).default("/"), course_id: z.number().int().positive().nullable().default(null) })
      .strict()
      .default({ path: "/", course_id: null }),
  })
  .strict();

const disabled = () => new HttpError(503, "AI_DISABLED", "AI Chat is not set up on this server.");

const AI_ERRORS: Record<AiError["kind"], { status: number; code: string }> = {
  auth: { status: 502, code: "AI_AUTH_FAILED" },
  rate_limited: { status: 503, code: "AI_RATE_LIMITED" },
  bad_request: { status: 502, code: "AI_BAD_REQUEST" },
  unavailable: { status: 503, code: "AI_UNAVAILABLE" },
  bad_reply: { status: 502, code: "AI_BAD_REPLY" },
};

export function aiRouter(db: Db, services: Services): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ enabled: services.ai !== null, model: services.ai?.model ?? null });
  });

  /** One turn: the model reads what it needs with read-only tools and answers. Nothing is stored. */
  router.post("/chat", async (req, res) => {
    const provider = services.ai;
    if (!provider) throw disabled();
    const { user } = currentAuth(res.locals);
    const body = chatRequest.parse(req.body ?? {});
    await enforce(
      db,
      [
        { key: `ai:${user.id}`, ...AI_TURNS_PER_ACCOUNT },
        { key: `ai-net:${req.ip}`, ...AI_TURNS_PER_NETWORK },
      ],
      "You've sent a lot of messages to AI Chat. Try again in a few minutes.",
    );
    const settings = await getSettings(db, user.id);
    try {
      const result = await chatTurn(
        provider,
        { db, services, userId: user.id, preview: isPreview(user), timeZone: settings.timeZone, now: new Date() },
        { history: body.messages, page: { path: body.page.path, courseId: body.page.course_id } },
      );
      res.json(result);
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      const { status, code } = AI_ERRORS[error.kind];
      throw new HttpError(status, code, error.message);
    }
  });

  return router;
}
