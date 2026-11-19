// AI on single tasks: asking for a fresh effort estimate. Mounted on /api/tasks ahead of the tasks router.
import { Router } from "express";
import { aiProviderFor } from "../ai/resolve.js";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { HttpError } from "../http/errors.js";
import { idParam } from "../http/params.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import type { Services } from "../services.js";

const taskNotFound = () => new HttpError(404, "TASK_NOT_FOUND", "That task could not be found.");

export function aiTasksRouter(db: Db, services: Services): Router {
  const router = Router();

  /** Starts a new AI estimate of the task's total work; the old one stays in use until it is ready. */
  router.post("/:id/reestimate", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const task = await db.task.findFirst({ where: { id: idParam(req.params.id, taskNotFound()), userId: user.id } });
    if (!task) throw taskNotFound();
    if (isPreview(user)) throw previewUnavailable();
    if (task.source !== "CANVAS") throw new HttpError(409, "TASK_NOT_FROM_CANVAS", "AI estimates are made for Canvas assignments.");
    if (!(await aiProviderFor(db, services, user.id))) throw new HttpError(503, "AI_DISABLED", "AI is not set up. Add an AI provider in Settings.");
    await services.aiJobs.reestimate(user.id, task.id);
    res.status(202).json({ state: "pending" });
  });

  return router;
}
