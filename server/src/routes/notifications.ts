import { Router } from "express";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam } from "../http/params.js";
import { bannerOrder, presentNotification } from "../notifications/notify.js";

/** Banners shown at once; more would push the page itself out of view. */
const SHOWN = 3;

const notFound = () => new HttpError(404, "NOTIFICATION_NOT_FOUND", "That notification could not be found.");

export function notificationsRouter(db: Db): Router {
  const router = Router();

  /**
   * Banners not dismissed yet: critical first, then newest. The newest few of each level are read
   * from the database, so an older critical notice is never hidden behind many newer ones.
   */
  router.get("/", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const newest = (level: Prisma.StringFilter | string) =>
      db.notification.findMany({
        where: { userId, dismissedAt: null, level },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: SHOWN,
      });
    const levels = await Promise.all([newest("critical"), newest("important"), newest({ notIn: ["critical", "important"] })]);
    res.json(levels.flat().sort(bannerOrder).slice(0, SHOWN).map(presentNotification));
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
