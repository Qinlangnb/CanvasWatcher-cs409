// Preview accounts let someone look around the app without an account or Canvas, for example during a
// usability evaluation. Each visitor gets a separate account holding a copy of one real account's data
// (the template, named by PREVIEW_SOURCE_USERNAME), with that person's name, username, email and Canvas
// id taken out. A preview can do everything a normal account does with that copy, but it has no Canvas
// token and no password: anything that needs Canvas itself (connecting, syncing, downloads, syllabus)
// answers "Preview account not available". It is deleted when the visitor signs out or after PREVIEW_LIFETIME.
import { randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { contentHash, type Content } from "../canvas/normalize.js";
import { isUniqueViolation, type Db } from "../db.js";
import type { CanvasConnection, Prisma, User } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";

export const PREVIEW_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export const PREVIEW_NAME = "Preview Student";
/** Not an argon2 hash: password checks fail on it, so nobody can sign in to a preview account. */
const NO_PASSWORD = "!preview-account";
/** Not a sealed token: opening it fails, so a preview can never reach Canvas. */
const NO_TOKEN = "!preview-account";
const CLEANUP_INTERVAL_MS = 10 * 60_000;
/** Copying a large account takes a moment; Prisma's default of 5 seconds is too tight. */
const COPY_TIMEOUT_MS = 60_000;

/** Preview accounts are the only accounts with an expiry. */
export const isPreview = (user: Pick<User, "previewExpiresAt">): boolean => user.previewExpiresAt !== null;

export const previewUnavailable = () => new HttpError(403, "PREVIEW_ACCOUNT", "Preview account not available.");

/** The account previews copy, or null when previews are off or that account doesn't exist. */
export async function findTemplate(db: Db, username: string | null): Promise<User | null> {
  if (!username) return null;
  const user = await db.user.findUnique({ where: { usernameKey: username.toLowerCase() } });
  return user && !isPreview(user) ? user : null;
}

/** Creates a preview user holding a scrubbed copy of the template's data. */
export async function createPreviewAccount(db: Db, template: User, now = new Date()): Promise<User> {
  for (let attempt = 1; ; attempt += 1) {
    const username = `preview-${randomBytes(4).toString("hex")}`;
    try {
      return await db.$transaction(
        async (tx) => {
          const user = await tx.user.create({
            data: {
              username,
              usernameKey: username,
              email: `${randomUUID()}@preview.invalid`,
              passwordHash: NO_PASSWORD,
              previewExpiresAt: new Date(now.getTime() + PREVIEW_LIFETIME_MS),
            },
          });
          await copyAccount(tx, template, user.id);
          return user;
        },
        { timeout: COPY_TIMEOUT_MS },
      );
    } catch (error) {
      if (attempt < 3 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

/** Replaces everything in a preview account with a fresh copy of the template. The expiry stays the same. */
export async function resetPreview(db: Db, userId: string, template: User): Promise<void> {
  await db.$transaction(
    async (tx) => {
      // Tasks, files, source items and changes go with their courses; imported events with their source.
      await tx.course.deleteMany({ where: { userId } });
      await tx.syncRun.deleteMany({ where: { userId } });
      await tx.calendarSource.deleteMany({ where: { userId } });
      await tx.calendarEvent.deleteMany({ where: { userId } });
      await tx.canvasConnection.deleteMany({ where: { userId } });
      await tx.userSettings.deleteMany({ where: { userId } });
      await copyAccount(tx, template, userId);
    },
    { timeout: COPY_TIMEOUT_MS },
  );
}

export async function deleteExpiredPreviews(db: Db, now = new Date()): Promise<number> {
  const { count } = await db.user.deleteMany({ where: { previewExpiresAt: { lte: now } } });
  return count;
}

/** Deletes expired preview accounts now and every few minutes. Returns a stop function. */
export function startPreviewCleanup(db: Db, logger: Logger): () => void {
  const tick = () => {
    deleteExpiredPreviews(db)
      .then((deleted) => {
        if (deleted > 0) logger.info({ deleted }, "expired preview accounts deleted");
      })
      .catch((error: unknown) => logger.error({ err: error }, "preview cleanup failed"));
  };
  tick();
  const timer = setInterval(tick, CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Matches `word` only as a whole word, in any script. */
const wholeWord = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])`, "giu");

/**
 * Takes the template's identity out of text: their email, username, Canvas name and the words of it,
 * and their Canvas user id (in links it becomes `self`, which Canvas reads as whoever is signed in).
 */
export function identityScrubber(
  template: Pick<User, "username" | "email">,
  canvas: Pick<CanvasConnection, "displayName" | "canvasUserId"> | null,
) {
  const rules: [RegExp, string][] = [[new RegExp(escape(template.email), "gi"), "student@example.com"]];
  const name = canvas?.displayName.trim() ?? "";
  if (name) rules.push([wholeWord(name), PREVIEW_NAME]);
  const words = new Set<string>();
  for (const word of [...name.split(/[\s,]+/), template.username, template.email.split("@")[0] ?? ""]) {
    // Short Latin words are too likely to be ordinary words; names in other scripts are often two characters.
    const trimmed = word.trim();
    if (trimmed.length >= 3 || (trimmed.length === 2 && /[^\p{ASCII}]/u.test(trimmed))) words.add(trimmed);
  }
  for (const word of [...words].sort((a, b) => b.length - a.length)) rules.push([wholeWord(word), "Student"]);
  // Short ids would also match ordinary numbers; real Canvas user ids are long.
  const id = canvas?.canvasUserId ?? "";
  if (/^\d{5,}$/.test(id)) rules.push([new RegExp(`(?<!\\d)${id}(?!\\d)`, "g"), "self"]);

  const text = (value: string): string => rules.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), value);
  const optional = (value: string | null): string | null => (value === null ? null : text(value));
  const json = <T>(value: T): T => {
    if (typeof value === "string") return text(value) as T;
    if (Array.isArray(value)) return value.map(json) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)])) as T;
    }
    return value;
  };
  return { text, optional, json };
}

const asJson = (value: Prisma.JsonValue | null): Prisma.InputJsonValue | undefined =>
  value === null ? undefined : (value as Prisma.InputJsonValue);

/** Copies the template's courses, tasks, files, changes, calendar and settings to `userId`, scrubbed. */
async function copyAccount(tx: Prisma.TransactionClient, template: User, userId: string): Promise<void> {
  const from = template.id;
  const canvas = await tx.canvasConnection.findUnique({ where: { userId: from } });
  const scrub = identityScrubber(template, canvas);

  const settings = await tx.userSettings.findUnique({ where: { userId: from } });
  if (settings) {
    const { userId: _owner, updatedAt: _updated, ...rest } = settings;
    await tx.userSettings.create({ data: { ...rest, userId } });
  }
  if (canvas) {
    // No token: the preview shows the same Canvas address and links, but can never call Canvas.
    await tx.canvasConnection.create({
      data: {
        userId,
        baseUrl: canvas.baseUrl,
        tokenCiphertext: NO_TOKEN,
        canvasUserId: "preview",
        displayName: PREVIEW_NAME,
        status: "OK",
        verifiedAt: canvas.verifiedAt,
        lastSyncedAt: canvas.lastSyncedAt,
      },
    });
  }
  // The latest sync that worked, so the app says when this data was last fresh.
  const run = await tx.syncRun.findFirst({
    where: { userId: from, status: { in: ["SUCCEEDED", "PARTIAL"] } },
    orderBy: { startedAt: "desc" },
  });
  if (run) {
    const { id: _id, userId: _owner, ...rest } = run;
    await tx.syncRun.create({ data: { ...rest, userId, error: scrub.optional(rest.error) } });
  }

  const courses = await tx.course.findMany({ where: { userId: from }, orderBy: { id: "asc" } });
  const courseIds = new Map<number, number>();
  for (const { id, userId: _owner, createdAt: _created, updatedAt: _updated, ...rest } of courses) {
    const copy = await tx.course.create({
      data: { ...rest, userId, name: scrub.text(rest.name), courseCode: scrub.text(rest.courseCode), htmlUrl: scrub.text(rest.htmlUrl) },
    });
    courseIds.set(id, copy.id);
  }
  const course = (id: number) => {
    const copy = courseIds.get(id);
    if (copy === undefined) throw new Error("preview copy: a row refers to a course that was not copied");
    return copy;
  };

  const tasks = await tx.task.findMany({ where: { userId: from }, orderBy: { id: "asc" } });
  await tx.task.createMany({
    data: tasks.map(({ id: _id, userId: _owner, updatedAt: _updated, ...task }) => ({
      ...task,
      userId,
      courseId: course(task.courseId),
      title: scrub.text(task.title),
      htmlUrl: scrub.optional(task.htmlUrl),
      notes: scrub.optional(task.notes),
    })),
  });

  const files = await tx.courseFile.findMany({ where: { userId: from }, orderBy: { id: "asc" } });
  await tx.courseFile.createMany({
    data: files.map(({ id: _id, userId: _owner, createdAt: _created, updatedAt: _updated, ...file }) => ({
      ...file,
      userId,
      courseId: course(file.courseId),
      displayName: scrub.text(file.displayName),
    })),
  });

  // Source items are found again by their unique (course, kind, Canvas id), so changes can point at the copies.
  const items = await tx.sourceItem.findMany({ where: { userId: from }, orderBy: { id: "asc" } });
  const copies = await tx.sourceItem.createManyAndReturn({
    data: items.map(({ id: _id, userId: _owner, ...item }) => {
      const content = scrub.json(item.content) as Content;
      return {
        ...item,
        userId,
        courseId: course(item.courseId),
        title: scrub.text(item.title),
        htmlUrl: scrub.optional(item.htmlUrl),
        content,
        contentHash: contentHash(content),
      };
    }),
    select: { id: true, courseId: true, kind: true, canvasId: true },
  });
  const itemKey = (courseId: number, kind: string, canvasId: string) => `${courseId}|${kind}|${canvasId}`;
  const copyByKey = new Map(copies.map((copy) => [itemKey(copy.courseId, copy.kind, copy.canvasId), copy.id]));
  const itemIds = new Map(items.map((item) => [item.id, copyByKey.get(itemKey(course(item.courseId), item.kind, item.canvasId))]));

  // Created oldest first: the feed is ordered by id.
  const changes = await tx.changeEvent.findMany({ where: { userId: from }, orderBy: { id: "asc" } });
  await tx.changeEvent.createMany({
    data: changes.map(({ id: _id, userId: _owner, before, after, ...change }) => {
      const sourceItemId = itemIds.get(change.sourceItemId);
      if (sourceItemId === undefined) throw new Error("preview copy: a change refers to an item that was not copied");
      return {
        ...change,
        userId,
        courseId: course(change.courseId),
        sourceItemId,
        summary: scrub.text(change.summary),
        before: asJson(scrub.json(before)),
        after: asJson(scrub.json(after)),
      };
    }),
  });

  const sources = await tx.calendarSource.findMany({ where: { userId: from }, orderBy: { id: "asc" } });
  const sourceIds = new Map<number, number>();
  for (const { id, userId: _owner, ...source } of sources) {
    const copy = await tx.calendarSource.create({
      data: { ...source, userId, name: scrub.text(source.name), fileName: scrub.optional(source.fileName) },
    });
    sourceIds.set(id, copy.id);
  }
  const events = await tx.calendarEvent.findMany({ where: { userId: from }, orderBy: { id: "asc" } });
  await tx.calendarEvent.createMany({
    data: events.map(({ id: _id, userId: _owner, createdAt: _created, updatedAt: _updated, ...event }) => ({
      ...event,
      userId,
      sourceId: event.sourceId === null ? null : (sourceIds.get(event.sourceId) ?? null),
      title: scrub.text(event.title),
      location: scrub.optional(event.location),
    })),
  });
}
