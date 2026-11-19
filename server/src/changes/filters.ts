// Noise filters: declarative rules that keep a kind of change away from AI review. A rule names one course,
// source and transition, one text field, and a literal pattern; there is no regex, SQL or code. The AI may
// propose a rule only after three rejected candidates match it, and every change to a rule is audited.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.js";
import type { ChangeFilterRule, Prisma } from "../generated/prisma/client.js";

type Tx = Db | Prisma.TransactionClient;

export const FILTER_FIELDS = ["title", "description", "body", "text", "filename", "display_name"] as const;
export const FILTER_OPERATORS = ["equals", "contains", "prefix", "suffix"] as const;
/** Most rules one user can have, removed ones included. */
export const RULE_CAPACITY = 100;
/** Rejected reviews that must match a rule before the AI may create or change it. */
export const EVIDENCE_NEEDED = 3;

export const filterSpec = z.strictObject({
  action: z.literal("SUPPRESS_FROM_AI_REVIEW").default("SUPPRESS_FROM_AI_REVIEW"),
  course_id: z.number().int().positive(),
  source_type: z.string().min(1).max(40),
  source_name: z.string().min(1).max(200),
  change_type: z.string().min(1).max(80),
  field: z.enum(FILTER_FIELDS),
  operator: z.enum(FILTER_OPERATORS),
  pattern: z.string().trim().min(3).max(160),
});
export type FilterSpec = z.infer<typeof filterSpec>;

export const filterMutation = z.strictObject({
  operation: z.enum(["create", "update", "disable"]),
  rule_id: z.number().int().positive().nullish(),
  rule: filterSpec.nullish(),
  reason: z.string().min(1).max(500),
});

/** What filters and the AI see of a change (built in review.ts). */
export interface ReviewContext {
  course_id: number;
  source_type: string;
  source_name: string;
  change_type: string;
  title: string;
  fields: string[];
  before: Record<string, string | null>;
  after: Record<string, string | null>;
  old_text: string;
  new_text: string;
}

export class FilterFeedbackError extends Error {}

export function matches(spec: FilterSpec, context: Partial<ReviewContext>): boolean {
  if (
    spec.course_id !== context.course_id ||
    spec.source_type !== context.source_type ||
    spec.source_name !== context.source_name ||
    spec.change_type !== context.change_type
  ) {
    return false;
  }
  // An update must have changed only this field, so a wording rule never hides a deadline moved at the same time.
  // A new item has every field "changed"; there the field only has to exist.
  const created = context.change_type?.endsWith("_created") ?? false;
  const after = context.after ?? {};
  if (created ? !(spec.field in after) : JSON.stringify(context.fields ?? []) !== JSON.stringify([spec.field])) return false;
  const value = String(after[spec.field] ?? "").trim().toLocaleLowerCase();
  const pattern = spec.pattern.trim().toLocaleLowerCase();
  if (pattern.length < 3) return false;
  if (spec.operator === "equals") return value === pattern;
  if (spec.operator === "contains") return value.includes(pattern);
  if (spec.operator === "prefix") return value.startsWith(pattern);
  return value.endsWith(pattern);
}

/** A rule's family is everything but its operator and pattern; the AI may refine a family, never widen it. */
export function family(spec: FilterSpec): string {
  const { action, course_id, source_type, source_name, change_type, field } = spec;
  return createHash("sha256")
    .update(JSON.stringify({ action, change_type, course_id, field, source_name, source_type }))
    .digest("hex");
}

const stateOf = (row: ChangeFilterRule) => ({ rule: row.rule, enabled: row.enabled, removed: row.removed }) as Prisma.InputJsonObject;

async function audit(tx: Tx, row: ChangeFilterRule, actor: string, action: string, reason: string, before: Prisma.InputJsonObject | null) {
  await tx.changeFilterAudit.create({
    data: { userId: row.userId, ruleId: row.id, version: row.version, actor, action, reason, before: before ?? undefined, after: stateOf(row) },
  });
}

/** Enables, disables or (softly) removes a rule. Enabling a removed rule restores it. Null when it is not this user's. */
export async function setRuleEnabled(
  db: Db,
  userId: string,
  ruleId: number,
  change: { enabled: boolean; remove?: boolean; actor?: "AI" | "USER"; reason?: string },
): Promise<ChangeFilterRule | null> {
  return db.$transaction(async (tx) => {
    const row = await tx.changeFilterRule.findFirst({ where: { id: ruleId, userId } });
    if (!row) return null;
    const remove = change.remove === true;
    const updated = await tx.changeFilterRule.update({
      where: { id: row.id },
      data: { enabled: change.enabled && !remove, removed: remove, version: { increment: 1 } },
    });
    const action = remove ? "remove" : change.enabled ? "enable" : "disable";
    await audit(tx, updated, change.actor ?? "USER", action, change.reason ?? "Changed in Settings.", stateOf(row));
    return updated;
  });
}

/**
 * Applies a rule the AI proposed while rejecting a change. Throws FilterFeedbackError when the proposal is not
 * allowed: rules the student disabled or removed, wider scopes, too little evidence, or a full rule list.
 */
export async function mutateFromReview(tx: Tx, userId: string, payload: unknown, context: ReviewContext): Promise<ChangeFilterRule> {
  const parsed = filterMutation.safeParse(payload);
  if (!parsed.success) throw new FilterFeedbackError("invalid_feedback");
  const mutation = parsed.data;
  let row = mutation.rule_id ? await tx.changeFilterRule.findFirst({ where: { id: mutation.rule_id, userId } }) : null;
  if (mutation.operation !== "create" && !row) throw new FilterFeedbackError("existing_rule_required");
  if (row && (row.createdBy !== "AI" || row.removed || !row.enabled)) throw new FilterFeedbackError("user_controlled_rule");
  if (mutation.operation === "disable" && row) {
    const spec = filterSpec.parse(row.rule);
    if (spec.course_id !== context.course_id || spec.source_type !== context.source_type || spec.source_name !== context.source_name) {
      throw new FilterFeedbackError("rule_scope_mismatch");
    }
    const updated = await tx.changeFilterRule.update({ where: { id: row.id }, data: { enabled: false, version: { increment: 1 } } });
    await audit(tx, updated, "AI", "disable", mutation.reason, stateOf(row));
    return updated;
  }
  const spec = mutation.rule;
  if (!spec || !matches(spec, context)) throw new FilterFeedbackError("rule_must_match_current_candidate");
  if (row && family(filterSpec.parse(row.rule)) !== family(spec)) throw new FilterFeedbackError("rule_scope_cannot_expand");

  const rejected = await tx.changeReview.findMany({
    where: { userId, status: "READY", notifyUser: false },
    orderBy: { id: "desc" },
    take: 200,
    select: { context: true },
  });
  const evidence = rejected.filter((review) => matches(spec, review.context as Partial<ReviewContext>)).length;
  if (evidence < EVIDENCE_NEEDED) throw new FilterFeedbackError("three_rejected_candidates_required");

  const key = family(spec);
  const existing = await tx.changeFilterRule.findUnique({ where: { userId_identityKey: { userId, identityKey: key } } });
  if (existing) {
    if (existing.removed || !existing.enabled || existing.createdBy !== "AI") throw new FilterFeedbackError("user_controlled_rule");
    row = existing;
  }
  if (!row) {
    if ((await tx.changeFilterRule.count({ where: { userId } })) >= RULE_CAPACITY) throw new FilterFeedbackError("rule_capacity_reached");
    const created = await tx.changeFilterRule.create({
      data: { userId, identityKey: key, rule: spec, reason: mutation.reason, createdBy: "AI" },
    });
    await audit(tx, created, "AI", "create", mutation.reason, null);
    return created;
  }
  const updated = await tx.changeFilterRule.update({
    where: { id: row.id },
    data: { rule: spec, reason: mutation.reason, version: { increment: 1 } },
  });
  await audit(tx, updated, "AI", "update", mutation.reason, stateOf(row));
  return updated;
}

export interface MatchedRule {
  id: number;
  version: number;
  created_by: string;
  reason: string;
}

/** The first enabled rule that matches; its match count goes up once per change, since each change is checked once. */
export async function matchingRule(tx: Tx, userId: string, context: ReviewContext, now = new Date()): Promise<MatchedRule | null> {
  const rules = await tx.changeFilterRule.findMany({
    where: { userId, enabled: true, removed: false },
    orderBy: { id: "asc" },
    take: RULE_CAPACITY,
  });
  for (const row of rules) {
    const spec = filterSpec.safeParse(row.rule);
    if (!spec.success || !matches(spec.data, context)) continue;
    await tx.changeFilterRule.update({ where: { id: row.id }, data: { matchCount: { increment: 1 }, lastMatchedAt: now } });
    return { id: row.id, version: row.version, created_by: row.createdBy, reason: row.reason };
  }
  return null;
}
