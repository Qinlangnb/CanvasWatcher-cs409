import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { CanvasError, openToken } from "../canvas/client.js";
import type { Db } from "../db.js";
import { demoFile, isDemo } from "../demo/accounts.js";
import type { Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import type { Services } from "../services.js";
import { notConnected } from "./canvas.js";
import { courseSummarySelect, presentFile } from "./present.js";

const listQuery = z.object({
  course_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The `next_cursor` of the previous page. */
  cursor: z.string().max(200).optional(),
});

// Files are listed by Canvas update time, newest first and unknown times last, then by id. A cursor
// holds the last file's (time, id) pair, so pages stay stable while files are added or removed.
type FileKey = { canvasUpdatedAt: Date | null; id: number };
const cursorShape = z.tuple([z.iso.datetime().nullable(), z.number().int().positive()]);

function encodeCursor(file: FileKey): string {
  return Buffer.from(JSON.stringify([file.canvasUpdatedAt?.toISOString() ?? null, file.id])).toString("base64url");
}

/** Files that come after the cursor in list order. */
function afterCursor(cursor: string): Prisma.CourseFileWhereInput {
  let decoded: unknown = null;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    // Reported below.
  }
  const parsed = cursorShape.safeParse(decoded);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_QUERY", "Invalid cursor parameter: use the next_cursor of the previous page.");
  }
  const [updated, id] = parsed.data;
  if (updated === null) return { canvasUpdatedAt: null, id: { lt: id } };
  const at = new Date(updated);
  return { OR: [{ canvasUpdatedAt: { lt: at } }, { canvasUpdatedAt: at, id: { lt: id } }, { canvasUpdatedAt: null }] };
}

const fileNotFound = () => new HttpError(404, "FILE_NOT_FOUND", "That file could not be found.");

export function filesRouter(db: Db, services: Services): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const query = parseQuery(listQuery, req.query);
    const where: Prisma.CourseFileWhereInput = {
      userId,
      removedAt: null,
      ...(query.course_id ? { courseId: query.course_id } : { course: { archivedAt: null } }),
      ...(query.q ? { displayName: { contains: query.q, mode: "insensitive" } } : {}),
      ...(query.cursor ? { AND: [afterCursor(query.cursor)] } : {}),
    };
    const rows = await db.courseFile.findMany({
      where,
      include: { course: { select: courseSummarySelect } },
      orderBy: [{ canvasUpdatedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    res.json({ items: page.map(presentFile), next_cursor: rows.length > query.limit && last ? encodeCursor(last) : null });
  });

  /** Redirects to a fresh, short-lived Canvas download link; file contents never pass through this server. */
  router.get("/:id/download", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const userId = user.id;
    const file = await db.courseFile.findFirst({
      where: { id: idParam(req.params.id, fileNotFound()), userId, removedAt: null },
      include: { course: { select: { canvasId: true } } },
    });
    if (!file) throw fileNotFound();
    if (isDemo(user)) throw demoFile();
    const connection = await db.canvasConnection.findUnique({ where: { userId } });
    if (!connection) throw notConnected();

    let link: URL;
    try {
      const client = services.canvas(connection.baseUrl, openToken(services.secrets, connection.tokenCiphertext, userId));
      const fresh = await client.file(file.course.canvasId, file.canvasId);
      link = new URL(fresh.url ?? "");
    } catch (error) {
      if (!(error instanceof CanvasError)) {
        if (error instanceof TypeError) throw new HttpError(502, "CANVAS_UNAVAILABLE", "Canvas did not return a download link.");
        throw error;
      }
      if (error.kind === "TOKEN_REJECTED") {
        await db.canvasConnection.updateMany({ where: { userId }, data: { status: "TOKEN_REJECTED" } });
        throw new HttpError(409, "CANVAS_RECONNECT_REQUIRED", "Canvas no longer accepts your access token. Reconnect Canvas in Settings.");
      }
      if (error.kind === "FORBIDDEN" || error.kind === "NOT_FOUND") {
        throw new HttpError(404, "FILE_UNAVAILABLE", "Canvas no longer offers this file to your account.");
      }
      throw new HttpError(502, "CANVAS_UNAVAILABLE", error.message);
    }
    if (link.protocol !== "https:") throw new HttpError(502, "CANVAS_UNAVAILABLE", "Canvas returned an unsafe download link.");
    res.redirect(302, link.toString());
  });

  return router;
}
