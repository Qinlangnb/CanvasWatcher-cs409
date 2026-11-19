import { Router } from "express";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import type { ChangeReview } from "../generated/prisma/client.js";
import type { Services } from "../services.js";
import { changeInclude, presentChange } from "./present.js";

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export function presentReview(review: ChangeReview) {
  return {
    status: review.status.toLowerCase(),
    notify_user: review.notifyUser,
    severity: review.severity,
    reason: review.reason,
    recommended_action: review.recommendedAction,
    reviewed_at: iso(review.reviewedAt),
  };
}

/** The AI review of changes: what needs the student's attention, and a way to run queued reviews now. */
export function changeReviewRouter(db: Db, services: Services): Router {
  const router = Router();

  /** Unread changes the AI said the student should see, for Today's "Needs attention". Newest review first. */
  router.get("/attention", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const reviews = await db.changeReview.findMany({
      where: { userId, status: "READY", notifyUser: true, changeEvent: { readAt: null, course: { archivedAt: null } } },
      include: { changeEvent: { include: changeInclude } },
      orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
      take: 10,
    });
    res.json({ items: reviews.map((review) => ({ change: presentChange(review.changeEvent), ...presentReview(review) })) });
  });

  /** Reviews this user's queued changes now instead of waiting for the next half-minute tick. */
  router.post("/reviews/run", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    res.json({ completed: await services.reviews.runOnce({ userId }) });
  });

  return router;
}
