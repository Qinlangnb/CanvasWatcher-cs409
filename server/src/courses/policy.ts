// A course's grading policy from Canvas assignment groups: each category's weight and its drop rules.
// Canvas is the authority here, so every sync replaces the stored copy.
import type { CanvasAssignmentGroup } from "../canvas/types.js";
import type { Db } from "../db.js";
import type { CoursePolicy, Prisma } from "../generated/prisma/client.js";

type Tx = Db | Prisma.TransactionClient;

export interface GradingCategory {
  id: string;
  name: string;
  /** Percent of the final grade, when the course weights its groups. */
  weight: number | null;
  drop_lowest: number;
  drop_highest: number;
  /** Canvas ids of assignments that are never dropped. */
  never_drop: string[];
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export function gradingCategories(groups: CanvasAssignmentGroup[]): GradingCategory[] {
  return [...groups]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((group) => ({
      id: String(group.id),
      name: group.name?.trim() || "Untitled group",
      weight: typeof group.group_weight === "number" && Number.isFinite(group.group_weight) ? group.group_weight : null,
      drop_lowest: count(group.rules?.drop_lowest),
      drop_highest: count(group.rules?.drop_highest),
      never_drop: (group.rules?.never_drop ?? []).map(String).slice(0, 200),
    }));
}

export async function savePolicy(tx: Tx, userId: string, courseId: number, weighted: boolean, groups: CanvasAssignmentGroup[], now: Date) {
  const data = { weighted, groups: gradingCategories(groups) as unknown as Prisma.InputJsonArray, fetchedAt: now };
  await tx.coursePolicy.upsert({ where: { courseId }, create: { courseId, userId, ...data }, update: data });
}

/** The API shape. `titles` names the never-dropped assignments, by Canvas id, from the course's tasks. */
export function presentPolicy(policy: CoursePolicy, titles: Map<string, string>) {
  const categories = policy.groups as unknown as GradingCategory[];
  return {
    source: "canvas",
    confidence: 1,
    weighted: policy.weighted,
    fetched_at: policy.fetchedAt.toISOString(),
    grading_categories: categories.map((category) => ({
      ...category,
      weight: policy.weighted ? category.weight : null,
      never_drop: category.never_drop.map((id) => ({ canvas_id: id, title: titles.get(id) ?? null })),
    })),
  };
}
