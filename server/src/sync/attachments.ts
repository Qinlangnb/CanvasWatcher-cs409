// Assignment attachments during sync: the Canvas files each assignment's description links to
// (canvas/attachments.ts), saved as task_file_links, plus the linking assignments' titles, which
// classify files whose own names say nothing (files/types.ts).
import { linkedFileIds } from "../canvas/attachments.js";
import type { CanvasAssignment } from "../canvas/types.js";
import type { Prisma } from "../generated/prisma/client.js";

export interface AssignmentLinks {
  /** Assignment Canvas id → linked file Canvas ids; only assignments whose description was read. */
  byAssignment: Map<string, string[]>;
  /** File Canvas id → titles of the assignments that link it. */
  contextTitles: Map<string, string[]>;
}

export function assignmentLinks(rows: CanvasAssignment[], courseCanvasId: string, baseUrl: string): AssignmentLinks {
  const byAssignment = new Map<string, string[]>();
  const contextTitles = new Map<string, string[]>();
  for (const assignment of rows) {
    // A description Canvas didn't send is unknown, not empty: its saved links stay.
    if (assignment.description === undefined) continue;
    const ids = linkedFileIds(assignment.description, courseCanvasId, baseUrl);
    byAssignment.set(String(assignment.id), ids);
    for (const id of ids) {
      const titles = contextTitles.get(id) ?? [];
      titles.push(assignment.name?.trim() || "Assignment");
      contextTitles.set(id, titles);
    }
  }
  return { byAssignment, contextTitles };
}

/** Makes each assignment task's file links match its description. */
export async function saveTaskFileLinks(
  tx: Prisma.TransactionClient,
  userId: string,
  courseId: number,
  byAssignment: Map<string, string[]>,
): Promise<void> {
  if (byAssignment.size === 0) return;
  const tasks = await tx.task.findMany({
    where: { courseId, source: "CANVAS", canvasId: { in: [...byAssignment.keys()] } },
    select: { id: true, canvasId: true, fileLinks: { select: { id: true, fileCanvasId: true } } },
  });
  const stale: number[] = [];
  const fresh: Prisma.TaskFileLinkCreateManyInput[] = [];
  for (const task of tasks) {
    const wanted = new Set(byAssignment.get(task.canvasId ?? "") ?? []);
    for (const link of task.fileLinks) {
      if (!wanted.delete(link.fileCanvasId)) stale.push(link.id);
    }
    for (const fileCanvasId of wanted) fresh.push({ userId, taskId: task.id, fileCanvasId });
  }
  if (stale.length > 0) await tx.taskFileLink.deleteMany({ where: { id: { in: stale } } });
  if (fresh.length > 0) await tx.taskFileLink.createMany({ data: fresh, skipDuplicates: true });
}
