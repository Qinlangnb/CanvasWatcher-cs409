import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { RULE_CAPACITY, setRuleEnabled } from "../changes/filters.js";
import type { Db } from "../db.js";
import type { ChangeFilterAudit, ChangeFilterRule } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam } from "../http/params.js";

const enabledBody = z.strictObject({ enabled: z.boolean({ error: "Send enabled as true or false." }) });
const ruleNotFound = () => new HttpError(404, "FILTER_NOT_FOUND", "That filter could not be found.");
const iso = (date: Date | null) => (date ? date.toISOString() : null);

function presentRule(rule: ChangeFilterRule & { audits: ChangeFilterAudit[] }, courseCodes: Map<number, string>) {
  const spec = rule.rule as { course_id?: number };
  return {
    id: rule.id,
    enabled: rule.enabled,
    removed: rule.removed,
    rule: rule.rule,
    course_code: typeof spec.course_id === "number" ? (courseCodes.get(spec.course_id) ?? null) : null,
    reason: rule.reason,
    created_by: rule.createdBy,
    created_at: iso(rule.createdAt),
    updated_at: iso(rule.updatedAt),
    version: rule.version,
    match_count: rule.matchCount,
    last_matched_at: iso(rule.lastMatchedAt),
    audit: rule.audits.map((entry) => ({
      actor: entry.actor,
      action: entry.action,
      reason: entry.reason,
      version: entry.version,
      created_at: iso(entry.createdAt),
    })),
  };
}

/** Settings → Important Changes review and noise filters. Rules are only ever disabled or softly removed. */
export function changeFiltersRouter(db: Db): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const [rules, reviews, courses] = await Promise.all([
      db.changeFilterRule.findMany({
        where: { userId },
        include: { audits: { orderBy: { id: "desc" }, take: 10 } },
        orderBy: { id: "asc" },
        take: RULE_CAPACITY,
      }),
      db.changeReview.findMany({
        where: { userId },
        include: { changeEvent: { select: { summary: true, course: { select: { courseCode: true } } } } },
        orderBy: { id: "desc" },
        take: 30,
      }),
      db.course.findMany({ where: { userId }, select: { id: true, courseCode: true } }),
    ]);
    const codes = new Map(courses.map((course) => [course.id, course.courseCode]));
    res.json({
      rules: rules.map((rule) => presentRule(rule, codes)),
      recent_reviews: reviews.map((review) => ({
        change_id: review.changeEventId,
        summary: `${review.changeEvent.course.courseCode}: ${review.changeEvent.summary}`,
        status: review.status.toLowerCase(),
        stage1: review.stage1,
        stage1_reason: review.stage1Reason,
        notify_user: review.notifyUser,
        reason: review.reason,
        matched_rule: review.matchedRule,
        error: review.error,
      })),
    });
  });

  router.patch("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const id = idParam(req.params.id, ruleNotFound());
    const body = enabledBody.parse(req.body ?? {});
    const rule = await setRuleEnabled(db, userId, id, { enabled: body.enabled, reason: body.enabled ? "Enabled in Settings." : "Disabled in Settings." });
    if (!rule) throw ruleNotFound();
    res.json({ id: rule.id, enabled: rule.enabled, removed: rule.removed, version: rule.version });
  });

  /** A soft remove: the rule stops matching, and it and its audit history stay so it can be restored. */
  router.delete("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const id = idParam(req.params.id, ruleNotFound());
    const rule = await setRuleEnabled(db, userId, id, { enabled: false, remove: true, reason: "Removed in Settings." });
    if (!rule) throw ruleNotFound();
    res.json({ id: rule.id, removed: true });
  });

  return router;
}
