import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { parseQuery } from "../http/params.js";
import { courseSummarySelect, openTaskWhere, presentTask } from "./present.js";

const listQuery = z.object({
  course_id: z.coerce.number().int().positive().optional(),
  /** `open` is everything not yet handed in, overdue included. */
  status: z.enum(["open", "all"]).default("open"),
});

export function tasksRouter(db: Db): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const query = parseQuery(listQuery, req.query);
    const where: Prisma.TaskWhereInput = {
      userId,
      // Tasks of archived courses only show up when that course is asked for.
      ...(query.course_id ? { courseId: query.course_id } : { course: { archivedAt: null } }),
      ...(query.status === "open" ? openTaskWhere : { removedAt: null }),
    };
    const tasks = await db.task.findMany({
      where,
      include: { course: { select: courseSummarySelect } },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      take: 1000,
    });
    const now = new Date();
    res.json(tasks.map((task) => presentTask(task, now)));
  });

  return router;
}
