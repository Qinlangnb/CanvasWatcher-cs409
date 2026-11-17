// The last syllabus found for each course is kept, so it can still be shown (and given to AI Chat)
// when Canvas can't be asked: in a preview, with a rejected token, or while Canvas is down.
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { Syllabus } from "./syllabus.js";

/** A sync looks the syllabus up again once the kept copy is this old. */
export const SYLLABUS_REFRESH_MS = 24 * 60 * 60_000;

export interface KeptSyllabus {
  syllabus: Syllabus;
  fetchedAt: Date;
}

export async function keepSyllabus(db: Db, userId: string, courseId: number, syllabus: Syllabus, now = new Date()): Promise<void> {
  const content = syllabus as unknown as Prisma.InputJsonValue;
  await db.courseSyllabus.upsert({
    where: { courseId },
    create: { courseId, userId, content, fetchedAt: now },
    update: { content, fetchedAt: now },
  });
}

export async function keptSyllabus(db: Db, userId: string, courseId: number): Promise<KeptSyllabus | null> {
  const row = await db.courseSyllabus.findFirst({ where: { courseId, userId } });
  return row ? { syllabus: row.content as unknown as Syllabus, fetchedAt: row.fetchedAt } : null;
}

/** True when there is no kept copy, or it is old enough for a sync to look again. */
export async function syllabusIsStale(db: Db, courseId: number, now = new Date()): Promise<boolean> {
  const row = await db.courseSyllabus.findUnique({ where: { courseId }, select: { fetchedAt: true } });
  return !row || now.getTime() - row.fetchedAt.getTime() >= SYLLABUS_REFRESH_MS;
}
