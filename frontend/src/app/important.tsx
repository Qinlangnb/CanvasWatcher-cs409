// Important Changes: banners at the top of the app, Today's "Needs attention", the noise-filter settings and a
// course's grading policy. Kept in one file so the shared pages only gain one line each.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { isApiError, request } from "./api";
import { formatDateTime, plural, timeAgo } from "./format";
import { BellIcon, CloseIcon } from "./icons";
import type { AppNotification, AttentionItem, ChangeFilters, CoursePolicy, FilterRule } from "./types";
import { useToast } from "./toast";
import { Alert, Badge, EmptyState, QueryError, SkeletonList, Spinner } from "./ui";

// --- Queries ---

const keys = {
  notifications: ["notifications"] as const,
  // Under "changes", so marking a change read refreshes it too.
  attention: ["changes", "attention"] as const,
  filters: ["change-filters"] as const,
  policy: (courseId: number) => ["courses", courseId, "policy"] as const,
};

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => request<AppNotification[]>("/api/notifications"),
    enabled,
    refetchInterval: 60_000,
  });
}

function useDismissNotification() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<void>(`/api/notifications/${id}/dismiss`, { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export function useAttention() {
  return useQuery({ queryKey: keys.attention, queryFn: () => request<{ items: AttentionItem[] }>("/api/changes/attention") });
}

function useChangeFilters() {
  return useQuery({ queryKey: keys.filters, queryFn: () => request<ChangeFilters>("/api/settings/change-filters") });
}

function useUpdateFilter() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ rule, remove }: { rule: FilterRule; remove?: boolean }) =>
      remove
        ? request(`/api/settings/change-filters/${rule.id}`, { method: "DELETE" })
        : request(`/api/settings/change-filters/${rule.id}`, { method: "PATCH", body: { enabled: !rule.enabled } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.filters }),
  });
}

function useCoursePolicy(courseId: number) {
  return useQuery({
    queryKey: keys.policy(courseId),
    queryFn: async () => {
      try {
        return await request<CoursePolicy>(`/api/courses/${courseId}/policy`);
      } catch (error) {
        // No policy is a normal answer: Canvas may hide assignment groups.
        if (isApiError(error, 404)) return null;
        throw error;
      }
    },
  });
}

// --- Banners ---

/** Critical banners interrupt (role=alert); important ones are announced politely. */
export function NotificationBanners() {
  const notifications = useNotifications();
  const dismiss = useDismissNotification();
  const toast = useToast();
  if (!notifications.data?.length) return null;
  return (
    <div className="banner notice-banners">
      {notifications.data.map((notice) => (
        <div key={notice.id} className={`notice-banner notice-${notice.level}`} role={notice.level === "critical" ? "alert" : "status"}>
          <div className="notice-body">
            <p className="notice-title">{notice.title}</p>
            <p>{notice.body}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={`Dismiss ${notice.title}`}
            disabled={dismiss.isPending && dismiss.variables === notice.id}
            onClick={() => dismiss.mutate(notice.id, { onError: () => toast("The notification could not be dismissed. Please retry.", "error") })}
          >
            <CloseIcon size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}

// --- Today: Needs attention ---

const SEVERITY_TONES = { low: "neutral", medium: "accent", high: "warning", critical: "danger" } as const;

/** Unread changes the AI review said the student should see. Hidden when there are none and no AI ever reviewed. */
export function AttentionSection({ now, onOpen }: { now: Date; onOpen: (id: number) => void }) {
  const attention = useAttention();
  const items = attention.data?.items ?? [];
  return (
    <section className="card" aria-labelledby="attention-heading">
      <div className="section-header">
        <h2 id="attention-heading">
          Needs attention {items.length > 0 ? <span className="count">{items.length}</span> : null}
        </h2>
      </div>
      {attention.isPending ? <SkeletonList rows={1} label="Loading changes that need attention" /> : null}
      {attention.isError ? <QueryError error={attention.error} retry={() => void attention.refetch()} /> : null}
      {attention.data && items.length === 0 ? <p className="muted">No actionable changes.</p> : null}
      {items.length > 0 ? (
        <ul className="attention-list">
          {items.map((item) => (
            <li key={item.change.id} className={`attention-card category-${item.change.category}`}>
              <div className="attention-head">
                {item.severity ? <Badge tone={SEVERITY_TONES[item.severity]}>{item.severity}</Badge> : null}
                <span className="course-chip">{item.change.course.code}</span>
                <span className="muted">{item.change.event_label}</span>
              </div>
              <p className="attention-summary">{item.reason ?? item.change.summary}</p>
              <p className="attention-meta">
                AI reviewed {item.reviewed_at ? <time dateTime={item.reviewed_at}>{timeAgo(item.reviewed_at, now)}</time> : null}
                {item.recommended_action ? ` · ${item.recommended_action}` : null}
              </p>
              <button type="button" className="button small secondary" onClick={() => onOpen(item.change.id)}>
                Review<span className="visually-hidden">: {item.change.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// --- Settings: Important Changes review and noise filters ---

const ACTION_LABELS: Record<string, string> = { create: "Created", update: "Updated", enable: "Enabled", disable: "Disabled", remove: "Removed" };

function RuleCard({ rule }: { rule: FilterRule }) {
  const update = useUpdateFilter();
  const toast = useToast();
  const state = rule.removed ? "Removed" : rule.enabled ? "Enabled" : "Disabled";
  const run = (remove: boolean) =>
    update.mutate(
      { rule, remove },
      {
        onSuccess: () => toast(remove ? "Rule removed; its audit history is preserved." : "Filter updated."),
        onError: () => toast("Filter could not be updated. Please retry.", "error"),
      },
    );
  return (
    <li className={`filter-rule${rule.enabled ? "" : " off"}`}>
      <div className="filter-rule-head">
        <h4>
          Rule #{rule.id} · {state}
        </h4>
        <span className="muted">
          {rule.created_by === "AI" ? "Proposed by AI" : "Added by you"} · version {rule.version} · {plural(rule.match_count, "match", "matches")}
        </span>
      </div>
      <p>{rule.reason}</p>
      <p className="muted">
        {rule.course_code ?? `Course ${rule.rule.course_id}`} · {rule.rule.source_name} · {rule.rule.change_type.replaceAll("_", " ")}
      </p>
      <code className="filter-rule-code">
        {rule.rule.field} {rule.rule.operator} "{rule.rule.pattern}"
      </code>
      <div className="filter-rule-actions">
        <button type="button" className="button small secondary" disabled={update.isPending} onClick={() => run(false)}>
          {rule.enabled ? "Disable" : "Enable / restore"}
        </button>
        {rule.removed ? null : (
          <button type="button" className="button small ghost" disabled={update.isPending} onClick={() => run(true)}>
            Remove
          </button>
        )}
        {update.isPending ? <Spinner size={16} label="Updating filter" /> : null}
      </div>
      {rule.audit.length > 0 ? (
        <details className="raw-metadata">
          <summary>Audit history</summary>
          <ul className="audit-list">
            {rule.audit.map((entry) => (
              <li key={`${entry.version}-${entry.action}-${entry.created_at}`}>
                {ACTION_LABELS[entry.action] ?? entry.action} by {entry.actor === "AI" ? "AI" : "you"} (v{entry.version}),{" "}
                {formatDateTime(entry.created_at)}: {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

export function ChangeFiltersSection() {
  const [open, setOpen] = useState(false);
  return (
    <section className="card settings-section" id="change-filters" aria-labelledby="change-filters-heading">
      <details className="change-filters" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <h2 id="change-filters-heading">Advanced · Important Changes review and noise filters</h2>
        </summary>
        <p className="muted">
          New files, announcements, grade releases and deadline changes are reviewed by AI before they reach Today and the banners. When
          the same kind of change is rejected again and again, the AI may propose a filter that skips it. Filters only ever compare plain
          text. You can disable or remove any of them; every change is kept in the audit history.
        </p>
        {open ? <ChangeFiltersBody /> : null}
      </details>
    </section>
  );
}

function ChangeFiltersBody() {
  const filters = useChangeFilters();
  if (filters.isPending) return <SkeletonList rows={2} label="Loading filters" />;
  if (filters.isError) return <QueryError error={filters.error} retry={() => void filters.refetch()} />;
  const { rules, recent_reviews: reviews } = filters.data;
  return (
    <div className="stack">
      {rules.length === 0 ? (
        <EmptyState icon={<BellIcon size={28} />} title="No noise filters yet">
          Filters appear here once the AI has seen the same kind of unimportant change at least three times.
        </EmptyState>
      ) : (
        <ul className="filter-rules">
          {rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} />
          ))}
        </ul>
      )}
      <h3>Recent review diagnostics</h3>
      {reviews.length === 0 ? (
        <p className="muted">No changes reviewed yet.</p>
      ) : (
        <ul className="review-diagnostics">
          {reviews.map((review) => (
            <li key={review.change_id}>
              <span className="review-summary">{review.summary}</span>
              <span className="muted">
                {review.status.replaceAll("_", " ")} · {review.stage1_reason.replaceAll("_", " ")}
                {review.matched_rule ? ` · rule #${review.matched_rule.id}` : ""}
                {review.reason ? ` · ${review.reason}` : ""}
                {review.error ? ` · error: ${review.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Course page: grading policy ---

export function GradingPolicy({ courseId }: { courseId: number }) {
  const policy = useCoursePolicy(courseId);
  if (policy.isPending || policy.data === null) return null;
  if (policy.isError) return <Alert tone="warning" title="The grading policy didn't load">{policy.error.message}</Alert>;
  const { grading_categories: categories, weighted, fetched_at } = policy.data;
  if (categories.length === 0) return null;
  return (
    <section className="card grading-policy" aria-labelledby={`grading-${courseId}`}>
      <div className="section-header">
        <h2 id={`grading-${courseId}`}>Grading policy</h2>
        <span className="muted">From Canvas · {formatDateTime(fetched_at)}</span>
      </div>
      {weighted ? null : <p className="muted">This course does not weight its assignment groups; points decide the grade.</p>}
      <div className="table-scroll">
        <table className="policy-table">
          <caption className="visually-hidden">Grading categories</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              {weighted ? <th scope="col">Weight</th> : null}
              <th scope="col">Drop rules</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => {
              const rules = [
                category.drop_lowest ? `Lowest ${category.drop_lowest} dropped` : null,
                category.drop_highest ? `Highest ${category.drop_highest} dropped` : null,
                category.never_drop.length
                  ? `Never dropped: ${category.never_drop.map((item) => item.title ?? `#${item.canvas_id}`).join(", ")}`
                  : null,
              ].filter(Boolean);
              return (
                <tr key={category.id}>
                  <th scope="row">{category.name}</th>
                  {weighted ? <td>{category.weight === null ? "—" : `${category.weight}%`}</td> : null}
                  <td>{rules.length ? rules.join(" · ") : "None"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
