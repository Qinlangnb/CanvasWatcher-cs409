// Demo accounts let someone try the app without a Canvas account, for example during a usability
// evaluation. Each visitor gets a separate account with sample data; it has no password, cannot
// connect Canvas, and is deleted when it signs out or after DEMO_LIFETIME.
import { randomBytes, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Logger } from "pino";
import { changeSummary, contentHash, type Content } from "../canvas/normalize.js";
import { isUniqueViolation, type Db } from "../db.js";
import type { ChangeType, ItemKind, Prisma, SyncRun, User } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";

export const DEMO_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export const DEMO_TIME_ZONE = "America/Chicago";
/** `.invalid` never resolves, so nothing can ever be sent to this address. */
export const DEMO_CANVAS_URL = "https://canvas.demo.invalid";
/** Not an argon2 hash: password checks fail on it, so nobody can sign in to a demo account. */
const NO_PASSWORD = "!demo-account";
const CLEANUP_INTERVAL_MS = 10 * 60_000;

export const isDemo = (user: Pick<User, "demoExpiresAt">): boolean => user.demoExpiresAt !== null;

export const demoForbidden = (message: string) => new HttpError(403, "DEMO_ACCOUNT", message);

export const demoFile = () =>
  new HttpError(409, "DEMO_FILE", "This is a sample file with no contents. In your own account, files download from Canvas.");

/** Creates a demo user with fresh sample data. */
export async function createDemoAccount(db: Db, now = new Date()): Promise<User> {
  for (let attempt = 1; ; attempt += 1) {
    const username = `demo-${randomBytes(4).toString("hex")}`;
    try {
      return await db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            username,
            usernameKey: username,
            email: `${randomUUID()}@demo.invalid`,
            passwordHash: NO_PASSWORD,
            demoExpiresAt: new Date(now.getTime() + DEMO_LIFETIME_MS),
          },
        });
        await seedDemo(tx, user.id, now);
        return user;
      });
    } catch (error) {
      if (attempt < 3 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

/** Replaces everything in a demo account with fresh sample data. The expiry stays the same. */
export async function resetDemo(db: Db, userId: string, now = new Date()): Promise<void> {
  await db.$transaction(async (tx) => {
    // Tasks, files, source items and changes go with their courses; imported events with their source.
    await tx.course.deleteMany({ where: { userId } });
    await tx.syncRun.deleteMany({ where: { userId } });
    await tx.calendarSource.deleteMany({ where: { userId } });
    await tx.calendarEvent.deleteMany({ where: { userId } });
    await tx.canvasConnection.deleteMany({ where: { userId } });
    await tx.userSettings.deleteMany({ where: { userId } });
    await seedDemo(tx, userId, now);
  });
}

/** A manual sync of a demo account: finishes at once and finds nothing new. */
export async function demoSync(db: Db, userId: string, now = new Date()): Promise<SyncRun> {
  return db.$transaction(async (tx) => {
    const coursesSynced = await tx.course.count({ where: { userId } });
    await tx.canvasConnection.update({ where: { userId }, data: { lastSyncedAt: now } });
    return tx.syncRun.create({
      data: { userId, trigger: "MANUAL", status: "SUCCEEDED", startedAt: now, finishedAt: now, coursesSynced, changesDetected: 0 },
    });
  });
}

export async function deleteExpiredDemos(db: Db, now = new Date()): Promise<number> {
  const { count } = await db.user.deleteMany({ where: { demoExpiresAt: { lte: now } } });
  return count;
}

/** Deletes expired demo accounts now and every few minutes. Returns a stop function. */
export function startDemoCleanup(db: Db, logger: Logger): () => void {
  const tick = () => {
    deleteExpiredDemos(db)
      .then((deleted) => {
        if (deleted > 0) logger.info({ deleted }, "expired demo accounts deleted");
      })
      .catch((error: unknown) => logger.error({ err: error }, "demo cleanup failed"));
  };
  tick();
  const timer = setInterval(tick, CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

type CourseKey = "cs" | "math" | "phys" | "rhet";

const COURSES: { key: CourseKey; canvasId: string; courseCode: string; name: string }[] = [
  { key: "cs", canvasId: "40901", courseCode: "CS 409", name: "The Art of Web Programming" },
  { key: "math", canvasId: "24102", courseCode: "MATH 241", name: "Calculus III" },
  { key: "phys", canvasId: "21203", courseCode: "PHYS 212", name: "University Physics: Electricity and Magnetism" },
  { key: "rhet", canvasId: "10504", courseCode: "RHET 105", name: "Principles of Academic Writing" },
];

interface DemoChange {
  course: CourseKey;
  kind: ItemKind;
  canvasId: string;
  title: string;
  type: ChangeType;
  before?: Content;
  after?: Content;
  detectedAt: Date;
  read: boolean;
}

const PDF = "application/pdf";

/**
 * Writes the sample data, with dates relative to `now` in America/Chicago: overdue work, work due
 * today, tomorrow and over the next weeks, recent changes (some unread), and two weeks of classes.
 */
export async function seedDemo(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<void> {
  const today = DateTime.fromJSDate(now, { zone: DEMO_TIME_ZONE }).startOf("day");
  const at = (days: number, hour: number, minute = 0) => today.plus({ days }).set({ hour, minute }).toJSDate();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const iso = (date: Date | null) => date?.toISOString() ?? null;

  // The latest sync, a few minutes ago, found the unread changes.
  const syncStarted = ago(12);
  const syncFinished = new Date(syncStarted.getTime() + 9_000);
  await tx.userSettings.create({ data: { userId, timeZone: DEMO_TIME_ZONE } });
  await tx.canvasConnection.create({
    data: {
      userId,
      baseUrl: DEMO_CANVAS_URL,
      tokenCiphertext: "demo",
      canvasUserId: "demo",
      displayName: "Demo Student",
      verifiedAt: ago(3 * 24 * 60),
      lastSyncedAt: syncFinished,
    },
  });
  await tx.syncRun.create({
    data: {
      userId,
      trigger: "CONNECT",
      status: "SUCCEEDED",
      startedAt: syncStarted,
      finishedAt: syncFinished,
      coursesSynced: COURSES.length,
      changesDetected: 3,
    },
  });

  const courseIds = {} as Record<CourseKey, number>;
  const courseUrl = (key: CourseKey) => `${DEMO_CANVAS_URL}/courses/${COURSES.find((course) => course.key === key)?.canvasId}`;
  for (const course of COURSES) {
    const row = await tx.course.create({
      data: {
        userId,
        canvasId: course.canvasId,
        courseCode: course.courseCode,
        name: course.name,
        termName: "Current term",
        termStartAt: today.minus({ days: 75 }).toJSDate(),
        termEndAt: today.plus({ days: 40 }).toJSDate(),
        htmlUrl: courseUrl(course.key),
        lastSeenAt: syncFinished,
      },
    });
    courseIds[course.key] = row.id;
  }

  const tasks: [CourseKey, string, string, string, Date | null, number | null, string, number][] = [
    // course, Canvas id, title, type, due, points, submission state, progress
    ["cs", "901", "MP1: Personal page", "project", at(-24, 23, 59), 100, "graded", 0],
    ["cs", "902", "MP2: Data visualization", "project", at(-10, 23, 59), 100, "graded", 0],
    ["cs", "903", "MP3 checkpoint", "homework", at(0, 23, 59), 20, "unsubmitted", 60],
    ["cs", "904", "MP3: Final submission", "project", at(5, 23, 59), 150, "unsubmitted", 20],
    ["cs", "905", "Final project proposal", "project", at(9, 17), 50, "unsubmitted", 0],
    ["math", "911", "Problem Set 9", "homework", at(-1, 23, 59), 30, "unsubmitted", 40],
    ["math", "912", "Quiz 10", "exam", at(1, 10), 20, "unsubmitted", 0],
    ["math", "913", "Problem Set 10", "homework", at(6, 23, 59), 30, "unsubmitted", 0],
    ["math", "914", "Midterm 2", "exam", at(12, 19), 100, "unsubmitted", 0],
    ["phys", "921", "Lab report 7", "homework", at(-3, 17), 25, "submitted", 0],
    ["phys", "922", "Pre-lab quiz 8", "homework", at(0, 23, 59), 5, "unsubmitted", 0],
    ["phys", "923", "Homework 10", "homework", at(4, 23, 59), 40, "unsubmitted", 0],
    ["phys", "924", "Lab report 8", "homework", at(13, 17), 25, "unsubmitted", 0],
    ["rhet", "931", "Reading: Chapter 6", "reading", at(1, 9), null, "unsubmitted", 0],
    ["rhet", "932", "Essay draft", "assignment", at(8, 23, 59), 50, "unsubmitted", 10],
    ["rhet", "933", "Peer review", "assignment", null, 10, "unsubmitted", 0],
  ];
  await tx.task.createMany({
    data: [
      ...tasks.map(([course, canvasId, title, taskType, dueAt, pointsPossible, submissionState, progress]) => ({
        userId,
        courseId: courseIds[course],
        canvasId,
        title,
        taskType,
        dueAt,
        pointsPossible,
        htmlUrl: `${courseUrl(course)}/assignments/${canvasId}`,
        submissionState,
        submittedAt: submissionState === "unsubmitted" || !dueAt ? null : new Date(dueAt.getTime() - 26 * 60 * 60_000),
        progress,
      })),
      {
        userId,
        courseId: courseIds.cs,
        source: "PERSONAL" as const,
        title: "Review React hooks notes",
        taskType: "reading",
        dueAt: at(2, 20),
        estimatedMinutes: 45,
        progress: 30,
        notes: "Before the MP3 deadline.",
      },
    ],
  });

  const files: [CourseKey, string, string, string, number, Date][] = [
    ["cs", "7001", "Lecture 18 - React state.pdf", PDF, 2_480_112, ago(150)],
    ["cs", "7002", "Lecture 17 - Routing.pdf", PDF, 1_903_448, ago(3 * 24 * 60)],
    ["cs", "7003", "MP3 starter code.zip", "application/zip", 5_120_330, ago(5 * 24 * 60)],
    ["cs", "7004", "Syllabus.pdf", PDF, 312_904, ago(70 * 24 * 60)],
    ["math", "7101", "Practice exam 2.pdf", PDF, 845_120, ago(2 * 24 * 60)],
    ["math", "7102", "Lecture notes - Week 11.pdf", PDF, 1_204_660, ago(4 * 24 * 60)],
    ["math", "7103", "Formula sheet.pdf", PDF, 220_480, ago(30 * 24 * 60)],
    ["phys", "7201", "Lab 8 handout.pdf", PDF, 604_288, ago(24 * 60)],
    [
      "phys",
      "7202",
      "Lecture 21 slides.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      8_402_115,
      ago(3 * 24 * 60),
    ],
    [
      "rhet",
      "7301",
      "Essay rubric.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      48_220,
      ago(6 * 24 * 60),
    ],
    ["rhet", "7302", "Reading - Chapter 6.pdf", PDF, 3_310_772, ago(8 * 24 * 60)],
  ];
  await tx.courseFile.createMany({
    data: files.map(([course, canvasId, displayName, contentType, sizeBytes, canvasUpdatedAt]) => ({
      userId,
      courseId: courseIds[course],
      canvasId,
      displayName,
      contentType,
      sizeBytes,
      canvasUpdatedAt,
    })),
  });

  const fileContent = (name: string, size: number, type: string, updated: Date): Content => ({
    name,
    size,
    content_type: type,
    updated_at: updated.toISOString(),
  });
  const assignment = (title: string, due: Date | null, points: number | null, description: string): Content => ({
    title,
    due_at: iso(due),
    lock_at: null,
    points_possible: points,
    description,
  });
  const announcement = (title: string, message: string, posted: Date): Content => ({
    title,
    message,
    posted_at: posted.toISOString(),
  });
  const found = new Date(syncStarted.getTime() + 6_000);
  const changes: DemoChange[] = [
    {
      course: "rhet",
      kind: "ANNOUNCEMENT",
      canvasId: "5301",
      title: "Welcome to week 11",
      type: "CREATED",
      after: announcement("Welcome to week 11", "This week we start the research essay. Read chapter 6 before Tuesday.", ago(6 * 24 * 60 + 30)),
      detectedAt: ago(6 * 24 * 60),
      read: true,
    },
    {
      course: "phys",
      kind: "ASSIGNMENT",
      canvasId: "920",
      title: "Homework 9",
      type: "REMOVED",
      before: assignment("Homework 9", at(-2, 23, 59), 40, "Chapter 27 problems 3, 7, 12."),
      detectedAt: ago(4 * 24 * 60),
      read: true,
    },
    {
      course: "rhet",
      kind: "ASSIGNMENT",
      canvasId: "932",
      title: "Essay draft",
      type: "UPDATED",
      before: assignment("Essay draft", at(6, 23, 59), 50, "Submit a full draft of your research essay."),
      after: assignment("Essay draft", at(8, 23, 59), 50, "Submit a full draft of your research essay."),
      detectedAt: ago(3 * 24 * 60),
      read: true,
    },
    {
      course: "math",
      kind: "FILE",
      canvasId: "7101",
      title: "Practice exam 2.pdf",
      type: "UPDATED",
      before: fileContent("Practice exam 2.pdf", 790_336, PDF, ago(9 * 24 * 60)),
      after: fileContent("Practice exam 2.pdf", 845_120, PDF, ago(2 * 24 * 60)),
      detectedAt: ago(2 * 24 * 60 - 20),
      read: true,
    },
    {
      course: "cs",
      kind: "ASSIGNMENT",
      canvasId: "904",
      title: "MP3: Final submission",
      type: "UPDATED",
      before: assignment("MP3: Final submission", at(5, 23, 59), 100, "Submit your app."),
      after: assignment("MP3: Final submission", at(5, 23, 59), 150, "Submit your app and a two-minute demo video."),
      detectedAt: ago(24 * 60),
      read: true,
    },
    {
      course: "math",
      kind: "ASSIGNMENT",
      canvasId: "912",
      title: "Quiz 10",
      type: "UPDATED",
      before: assignment("Quiz 10", at(1, 14), 20, "Covers sections 15.1 to 15.3."),
      after: assignment("Quiz 10", at(1, 10), 20, "Covers sections 15.1 to 15.3."),
      detectedAt: found,
      read: false,
    },
    {
      course: "phys",
      kind: "ANNOUNCEMENT",
      canvasId: "5201",
      title: "Office hours moved to Friday",
      type: "CREATED",
      after: announcement(
        "Office hours moved to Friday",
        "This week's office hours are on Friday from 3:00 to 4:00 PM in Loomis 276.",
        ago(40),
      ),
      detectedAt: found,
      read: false,
    },
    {
      course: "cs",
      kind: "FILE",
      canvasId: "7001",
      title: "Lecture 18 - React state.pdf",
      type: "CREATED",
      after: fileContent("Lecture 18 - React state.pdf", 2_480_112, PDF, ago(150)),
      detectedAt: found,
      read: false,
    },
  ];
  // Created oldest first: the feed is ordered by id.
  for (const change of changes) {
    const content = (change.after ?? change.before) as Content;
    const htmlUrl =
      change.kind === "FILE"
        ? `${courseUrl(change.course)}/files/${change.canvasId}`
        : `${courseUrl(change.course)}/${change.kind === "ASSIGNMENT" ? "assignments" : "discussion_topics"}/${change.canvasId}`;
    const item = await tx.sourceItem.create({
      data: {
        userId,
        courseId: courseIds[change.course],
        kind: change.kind,
        canvasId: change.canvasId,
        title: change.title,
        htmlUrl,
        contentHash: contentHash(content),
        content,
        firstSeenAt: change.type === "CREATED" ? change.detectedAt : ago(60 * 24 * 60),
        removedAt: change.type === "REMOVED" ? change.detectedAt : null,
      },
    });
    const fields =
      change.before && change.after
        ? Object.keys(change.after).filter((key) => JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after?.[key]))
        : [];
    await tx.changeEvent.create({
      data: {
        userId,
        courseId: courseIds[change.course],
        sourceItemId: item.id,
        changeType: change.type,
        fields,
        summary: changeSummary(change.kind, change.type, change.title, fields),
        ...(change.before ? { before: change.before } : {}),
        ...(change.after ? { after: change.after } : {}),
        detectedAt: change.detectedAt,
        readAt: change.read ? new Date(change.detectedAt.getTime() + 60 * 60_000) : null,
      },
    });
  }

  // A class schedule imported from an .ics file, from last week to two weeks ahead, and a few own events.
  const source = await tx.calendarSource.create({
    data: { userId, name: "Class schedule", fileName: "class-schedule.ics", importedAt: ago(3 * 24 * 60) },
  });
  const meetings: [string, string, number[], [number, number], [number, number]][] = [
    // title, location, ISO weekdays, start, end
    ["MATH 241 Lecture", "Altgeld Hall 314", [1, 3, 5], [10, 0], [10, 50]],
    ["CS 409 Lecture", "Siebel Center 1404", [2, 4], [11, 0], [12, 15]],
    ["RHET 105", "English Building 108", [2, 4], [9, 30], [10, 45]],
    ["PHYS 212 Lecture", "Loomis Laboratory 141", [1, 3], [13, 0], [13, 50]],
    ["PHYS 212 Lab", "Loomis Laboratory 257", [4], [14, 0], [15, 50]],
  ];
  const imported: Prisma.CalendarEventCreateManyInput[] = [];
  for (let day = -7; day <= 14; day += 1) {
    const weekday = today.plus({ days: day }).weekday;
    for (const [title, location, weekdays, [startHour, startMinute], [endHour, endMinute]] of meetings) {
      if (!weekdays.includes(weekday)) continue;
      imported.push({
        userId,
        sourceId: source.id,
        title,
        location,
        startAt: at(day, startHour, startMinute),
        endAt: at(day, endHour, endMinute),
      });
    }
  }
  const fair = today.plus({ days: 7 });
  await tx.calendarEvent.createMany({
    data: [
      ...imported,
      { userId, title: "Study group: MATH 241", location: "Grainger Library", startAt: at(1, 19), endAt: at(1, 20, 30) },
      { userId, title: "CS 409 office hours", location: "Siebel Center 0216", startAt: at(3, 15), endAt: at(3, 16) },
      {
        userId,
        title: "Engineering career fair",
        // All-day events are stored as UTC midnights of the first day and of the day after.
        startAt: new Date(Date.UTC(fair.year, fair.month - 1, fair.day)),
        endAt: new Date(Date.UTC(fair.year, fair.month - 1, fair.day + 1)),
        allDay: true,
        busy: false,
      },
    ],
  });
}
