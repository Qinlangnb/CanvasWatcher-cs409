import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { CanvasError } from "../canvas/client.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import type { Services } from "../services.js";
import { FILE_TYPES } from "../files/types.js";
import { notConnected } from "./canvas.js";
import { courseSummarySelect, presentFile } from "./present.js";

const listQuery = z.object({
  course_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The `next_cursor` of the previous page. */
  cursor: z.string().max(200).optional(),
  /** Only files of this type (the student's choice, else the detected one). */
  type: z.enum(FILE_TYPES).optional(),
});

const fileType = z.enum(FILE_TYPES, { error: `Choose one of: ${FILE_TYPES.join(", ")}.` });
const classification = z.object({ type: fileType }).strict();
const downloadQuery = z.object({
  /** "1" answers `{ url }` instead of redirecting, so a page can report a missing file first. */
  link: z.enum(["1"]).optional(),
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

/** Only well-known document types are labelled as such; anything else is sent as opaque bytes. */
function safeContentType(value: string | null): string {
  const type = (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^(application\/(pdf|zip|msword|vnd\.[\w.+-]+|x-ipynb\+json)|text\/(plain|csv|markdown|x-python))$/.test(type) ? type : "application/octet-stream";
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
      AND: [
        ...(query.cursor ? [afterCursor(query.cursor)] : []),
        ...(query.type ? [{ OR: [{ userOverrideType: query.type }, { userOverrideType: null, detectedType: query.type }] }] : []),
      ],
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

  /** Moves a file to another type; the choice survives syncs. */
  router.patch("/:id/classification", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = classification.parse(req.body ?? {});
    const file = await db.courseFile.findFirst({ where: { id: idParam(req.params.id, fileNotFound()), userId, removedAt: null } });
    if (!file) throw fileNotFound();
    const updated = await db.courseFile.update({
      where: { id: file.id },
      data: { userOverrideType: body.type },
      include: { course: { select: courseSummarySelect } },
    });
    res.json(presentFile(updated));
  });

  /** Redirects to a fresh, short-lived Canvas download link; file contents never pass through this server. */
  router.get("/:id/download", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const userId = user.id;
    const asLink = parseQuery(downloadQuery, req.query).link === "1";
    const file = await db.courseFile.findFirst({
      where: { id: idParam(req.params.id, fileNotFound()), userId, removedAt: null },
      include: { course: { select: { canvasId: true } } },
    });
    if (!file) throw fileNotFound();
    if (isPreview(user)) throw previewUnavailable();
    if (file.sourceId !== null) {
      // A course-website file: its checked bytes are kept here, since no Canvas link exists.
      if (asLink) {
        res.json({ url: `/api/files/${file.id}/download`, filename: file.displayName });
        return;
      }
      const blob = file.blobId === null || file.integrityStatus !== "VALID" ? null : await db.websiteBlob.findFirst({ where: { id: file.blobId, userId } });
      if (!blob) throw new HttpError(404, "FILE_UNAVAILABLE", "This website file could not be downloaded. Sync the website and try again.");
      res.set({
        "Content-Type": safeContentType(file.contentType),
        "Content-Length": String(blob.content.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.displayName)}`,
        "X-Content-Type-Options": "nosniff",
        // Never let a downloaded HTML or SVG run as part of this site.
        "Content-Security-Policy": "sandbox; default-src 'none'",
      });
      res.end(Buffer.from(blob.content));
      return;
    }
    const connection = await db.canvasConnection.findUnique({ where: { userId } });
    if (!connection) throw notConnected();

    let link: URL;
    const client = await services.credentials.routed(userId);
    try {
      if (!client?.hasCredential()) throw new CanvasError("TOKEN_REJECTED", "Canvas needs you to sign in again.");
      const fresh = await client.file(file.course.canvasId, file.canvasId);
      link = new URL(fresh.url ?? "");
    } catch (error) {
      if (!(error instanceof CanvasError)) {
        if (error instanceof TypeError) throw new HttpError(502, "CANVAS_UNAVAILABLE", "Canvas did not return a download link.");
        throw error;
      }
      if (error.kind === "TOKEN_REJECTED") {
        await services.credentials.markAuthRequired(userId);
        throw new HttpError(409, "CANVAS_RECONNECT_REQUIRED", "Canvas no longer accepts your access token. Reconnect Canvas in Settings.");
      }
      if (error.kind === "FORBIDDEN" || error.kind === "NOT_FOUND") {
        throw new HttpError(404, "FILE_UNAVAILABLE", "Canvas no longer offers this file to your account.");
      }
      throw new HttpError(502, "CANVAS_UNAVAILABLE", error.message);
    } finally {
      await client?.flush();
    }
    if (link.protocol !== "https:") throw new HttpError(502, "CANVAS_UNAVAILABLE", "Canvas returned an unsafe download link.");
    if (asLink) {
      res.json({ url: link.toString(), filename: file.displayName });
      return;
    }
    res.redirect(302, link.toString());
  });

  return router;
}
