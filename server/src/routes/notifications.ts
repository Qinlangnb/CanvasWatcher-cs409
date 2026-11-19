import { Router } from "express";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { HttpError } from "../http/errors.js";
import { idParam } from "../http/params.js";
import { bannerOrder, presentNotification } from "../notifications/notify.js";

/** Banners shown at once; more would push the page itself out of view. */
const SHOWN = 3;

const notFound = () => new HttpError(404, "NOTIFICATION_NOT_FOUND", "That notification could not be found.");

export function notificationsRouter(db: Db): Router {
  const router = Router();

  /** Banners not dismissed yet: critical first, then newest. */
  router.get("/", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const rows = await db.notification.findMany({
      where: { userId, dismissedAt: null },
      orderBy: { id: "desc" },
      take: 50,
    });
    res.json(rows.sort(bannerOrder).slice(0, SHOWN).map(presentNotification));
  });

  router.post("/:id/dismiss", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const id = idParam(req.params.id, notFound());
    const notice = await db.notification.findFirst({ where: { id, userId } });
    if (!notice) throw notFound();
    if (!notice.dismissedAt) await db.notification.update({ where: { id }, data: { dismissedAt: new Date() } });
    res.status(204).end();
  });

  return router;
}
