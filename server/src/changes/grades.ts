// Grade releases. The assignment's tracked content leaves the student's submission out, so grades are compared
// on the task row instead: when Canvas first shows a score or grade (or changes it), a "Grade released" change is
// recorded. Only the student's own score, grade and excusal are kept; Canvas never sends other students' data here.
import { changedFields, type Content } from "../canvas/normalize.js";
import type { Prisma } from "../generated/prisma/client.js";
import { saveChanges, type NewChange } from "./review.js";
import { gradeIsReleased } from "./taxonomy.js";

export interface GradeState {
  score: number | null;
  grade: string | null;
  excused: boolean;
}

export interface GradeChange {
  canvasId: string;
  title: string;
  fields: string[];
  before: Content;
  after: Content;
}

export const gradeContent = (state: GradeState): Content => ({ score: state.score, grade: state.grade, excused: state.excused ? 1 : 0 });

/** Null unless a previously known assignment now shows a grade that differs from before. A grade hidden again is not news. */
export function gradeChange(canvasId: string, title: string, previous: GradeState | undefined, next: GradeState): GradeChange | null {
  if (!previous) return null;
  const before = gradeContent(previous);
  const after = gradeContent(next);
  if (!gradeIsReleased(after)) return null;
  const fields = changedFields(before, after);
  return fields.length > 0 ? { canvasId, title, fields, before, after } : null;
}

export async function previousGrades(tx: Prisma.TransactionClient, courseId: number): Promise<Map<string, GradeState>> {
  const rows = await tx.task.findMany({
    where: { courseId, source: "CANVAS", removedAt: null },
    select: { canvasId: true, score: true, grade: true, excused: true },
  });
  return new Map(rows.map((row) => [row.canvasId as string, { score: row.score, grade: row.grade, excused: row.excused }]));
}

/** Saves one change per grade change, on the assignment's tracked item. Returns how many were new. */
export async function recordGradeChanges(
  tx: Prisma.TransactionClient,
  scope: { userId: string; courseId: number; now: Date },
  grades: GradeChange[],
): Promise<number> {
  if (grades.length === 0) return 0;
  const items = await tx.sourceItem.findMany({
    where: { courseId: scope.courseId, kind: "ASSIGNMENT", canvasId: { in: grades.map((grade) => grade.canvasId) } },
    select: { id: true, canvasId: true },
  });
  const ids = new Map(items.map((item) => [item.canvasId, item.id]));
  const changes: NewChange[] = [];
  for (const grade of grades) {
    const sourceItemId = ids.get(grade.canvasId);
    if (sourceItemId === undefined) continue;
    const verb = gradeIsReleased(grade.before) ? "updated" : "released";
    changes.push({
      userId: scope.userId,
      courseId: scope.courseId,
      sourceItemId,
      kind: "ASSIGNMENT",
      title: grade.title,
      changeType: "UPDATED",
      fields: grade.fields,
      summary: `Grade ${verb} for "${grade.title}"`,
      before: grade.before,
      after: grade.after,
      detectedAt: scope.now,
    });
  }
  return saveChanges(tx, changes);
}
