// Work timers. The running timer lives on the server (one per user) and in one query, not in a task
// card, so it keeps running when a card collapses or the page changes. WorkHeartbeat, mounted once in
// the app shell, checks in every few seconds while a timer runs and reports a lost connection.
import { useEffect, useRef, useState } from "react";
import { isApiError } from "./api";
import { ClockIcon } from "./icons";
import { sendHeartbeat, useActiveWork, useStartWork, useStopWork, workKeys } from "./parityQueries";
import { elapsedSince, formatElapsed } from "./taskHelpers";
import { useToast } from "./toast";
import type { ActiveWork, Task } from "./types";
import { Spinner } from "./ui";
import { useQueryClient } from "@tanstack/react-query";

export const HEARTBEAT_MS = 5_000;

/** Progress the student set that hasn't reached the server yet; the next heartbeat carries it. */
const unsavedProgress = new Map<number, number>();
export const rememberProgress = (taskId: number, value: number) => unsavedProgress.set(taskId, value);
export const forgetProgress = (taskId: number) => unsavedProgress.delete(taskId);

/** The current time, ticking every second while `running`. */
export function useTicker(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

/** Minutes the running timer has added to `taskId` so far (0 when it isn't running). */
export function useRunningMinutes(taskId: number): number {
  const active = useActiveWork().data;
  const running = active?.task_id === taskId;
  const now = useTicker(running);
  return running ? Math.round(elapsedSince(active.active_started_at, now) / 60) : 0;
}

export function WorkHeartbeat() {
  const active = useActiveWork().data ?? null;
  const client = useQueryClient();
  const toast = useToast();
  const failures = useRef(0);
  const warned = useRef(false);
  const latest = useRef<ActiveWork | null>(active);
  latest.current = active;

  useEffect(() => {
    if (!active) return;
    const taskId = active.task_id;
    const beat = async () => {
      const current = latest.current;
      if (!current || current.task_id !== taskId) return;
      const progress = unsavedProgress.get(taskId);
      try {
        const summary = await sendHeartbeat(taskId, {
          client_timestamp: new Date().toISOString(),
          expected_revision: current.state_revision,
          elapsed_snapshot_seconds: elapsedSince(current.active_started_at, Date.now()),
          ...(progress !== undefined ? { progress_percent: progress } : {}),
        });
        if (progress !== undefined) {
          forgetProgress(taskId);
          void client.invalidateQueries({ queryKey: ["tasks"] });
          void client.invalidateQueries({ queryKey: ["today"] });
        }
        if (summary.state_revision !== current.state_revision) void client.invalidateQueries({ queryKey: workKeys.active });
        failures.current = 0;
        if (warned.current) {
          warned.current = false;
          toast("Connection restored. Work progress is synchronized.", "success");
        }
      } catch (error) {
        // Stopped elsewhere (another tab, completing the task): show that instead of retrying.
        if (isApiError(error, 409) || isApiError(error, 404)) {
          void client.invalidateQueries({ queryKey: workKeys.active });
          return;
        }
        failures.current += 1;
        if (failures.current >= 3 && !warned.current) {
          warned.current = true;
          toast("Connection interrupted. Your timer and edits remain active locally; synchronization will keep retrying.", "error");
        }
      }
    };
    const timer = window.setInterval(() => void beat(), HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [active?.task_id, active?.active_session_id, client, toast]);

  return null;
}

/** "h:mm:ss" of the running timer, updated every second. */
export function LiveTimer({ startedAt }: { startedAt: string | null }) {
  const now = useTicker(true);
  return (
    <strong className="live-timer" aria-live="off">
      {formatElapsed(elapsedSince(startedAt, now))}
    </strong>
  );
}

function useWorkActions() {
  const start = useStartWork();
  const stop = useStopWork();
  const toast = useToast();
  return {
    pending: start.isPending || stop.isPending,
    start: (task: Pick<Task, "id">) =>
      start.mutate(task, {
        onSuccess: (summary) =>
          toast(summary.switched_from_task_id ? "Previous timer stopped; this task is now active." : "Work timer started.", "success"),
        onError: (error) => toast(error.message, "error"),
      }),
    stop: (taskId: number) =>
      stop.mutate(taskId, {
        onSuccess: () => toast("Work timer stopped and saved.", "success"),
        onError: (error) => toast(error.message, "error"),
      }),
  };
}

/** Start or Stop for one task, with "Working on" and the live time while it runs. */
export function WorkControl({ task, compact = false }: { task: Task; compact?: boolean }) {
  const active = useActiveWork().data ?? null;
  const actions = useWorkActions();
  const working = active?.task_id === task.id;
  if (!working && task.state !== "open" && task.state !== "overdue") return null;
  return (
    <span className={`work-control${working ? " working" : ""}${compact ? " compact" : ""}`} data-task-control>
      {working ? (
        <>
          <span className="working-label">Working on</span>
          <LiveTimer startedAt={active.active_started_at} />
        </>
      ) : null}
      <button
        type="button"
        className={`button small ${working ? "secondary" : "primary"}`}
        disabled={actions.pending}
        onClick={() => (working ? actions.stop(task.id) : actions.start(task))}
      >
        {actions.pending ? <Spinner size={14} /> : <ClockIcon size={14} />}
        {working ? "Stop" : "Start"}
        <span className="visually-hidden"> timer for {task.title}</span>
      </button>
    </span>
  );
}

/** Today's reminder of the running timer, wherever its task is listed (or collapsed). */
export function WorkingBanner() {
  const active = useActiveWork().data ?? null;
  const actions = useWorkActions();
  if (!active) return null;
  return (
    <section className="working-banner" aria-label="Running timer">
      <ClockIcon size={20} />
      <p className="working-banner-text">
        <span className="working-label">Working on</span>
        <span className="working-banner-title">
          <span className="course-chip">{active.course.code}</span> {active.task_title}
        </span>
      </p>
      <LiveTimer startedAt={active.active_started_at} />
      <button type="button" className="button small secondary" disabled={actions.pending} onClick={() => actions.stop(active.task_id)}>
        Stop
      </button>
    </section>
  );
}

/** Whether `taskId` has the running timer. */
export function useIsWorking(taskId: number): boolean {
  return useActiveWork().data?.task_id === taskId;
}
