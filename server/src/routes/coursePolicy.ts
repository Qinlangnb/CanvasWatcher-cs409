import { Router } from "express";
import { currentAuth } from "../auth/middleware.js";
import { presentPolicy } from "../courses/policy.js";
import type { Db } from "../db.js";
import { HttpError } from "../http/errors.js";
import { idParam } from "../http/params.js";

const courseNotFound = () => new HttpError(404, "COURSE_NOT_FOUND", "That course could not be found.");

/** GET /api/courses/:id/policy: the grading categories Canvas reported at the last sync. */
export function coursePolicyRouter(db: Db): Router {
  const router = Router();

  router.get("/:id/policy", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const course = await db.course.findFirst({ where: { id: idParam(req.params.id, courseNotFound()), userId }, select: { id: true } });
    if (!course) throw courseNotFound();
    const policy = await db.coursePolicy.findUnique({ where: { courseId: course.id } });
    if (!policy) throw new HttpError(404, "POLICY_NOT_FOUND", "Canvas has not shared a grading policy for this course yet.");
    const tasks = await db.task.findMany({ where: { userId, courseId: course.id, canvasId: { not: null } }, select: { canvasId: true, title: true } });
    res.json(presentPolicy(policy, new Map(tasks.map((task) => [task.canvasId as string, task.title]))));
  });

  return router;
}
