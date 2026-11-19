// The swimlane timeline from the original app: one lane per course along a date axis, a Now marker,
// drag to pan, and task dots that open the task's source (Enter or Space too). See timelineLayout.ts.
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useNavigate } from "react-router";
import { formatTaskDue } from "./taskExtras";
import { DRAG_THRESHOLD_PX, taskTarget } from "./taskHelpers";
import { useTaskEditor } from "./tasks";
import { compactDate, laneY, layoutTimeline, shortTitle, type TimelineLane } from "./timelineLayout";
import type { Task } from "./types";

function submissionLabel(task: Task): string {
  if (task.submission_state === "graded") return "Graded";
  if (task.submission_state === "submitted" || task.submission_state === "pending_review") return "Submission confirmed";
  if (task.completed_at) return "Local work complete";
  return task.source === "canvas" ? "Submission not confirmed" : "Your task";
}

export function SwimlaneTimeline({ tasks, lanes, now, zone }: { tasks: Task[]; lanes: TimelineLane[]; now: Date; zone: string }) {
  const layout = useMemo(() => layoutTimeline(tasks, lanes, now, zone), [tasks, lanes, now, zone]);
  const navigate = useNavigate();
  const editor = useTaskEditor();
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const moved = useRef(false);
  const [dragging, setDragging] = useState(false);

  // Without a source link, a dot opens the task in the editor instead.
  const openTask = (task: Task) => {
    const target = taskTarget(task);
    if (target) window.open(target, "_blank", "noopener,noreferrer");
    else editor.open(task);
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !viewport.current) return;
    moved.current = false;
    drag.current = { x: event.clientX, y: event.clientY, left: viewport.current.scrollLeft, top: viewport.current.scrollTop };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const element = viewport.current;
    const start = drag.current;
    if (!element || !start) return;
    if (!moved.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= DRAG_THRESHOLD_PX) return;
    moved.current = true;
    setDragging(true);
    if (!element.hasPointerCapture(event.pointerId)) element.setPointerCapture(event.pointerId);
    element.scrollLeft = start.left - (event.clientX - start.x);
    element.scrollTop = start.top - (event.clientY - start.y);
  };
  const up = () => {
    drag.current = null;
    setDragging(false);
  };
  const activate = (event: KeyboardEvent, action: () => void) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };

  return (
    <div
      ref={viewport}
      className={`swimlane-viewport${dragging ? " dragging" : ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        moved.current = true;
        up();
      }}
      onClickCapture={(event) => {
        // A drag that ends on a dot is not a click on it (keyboard clicks have detail 0).
        if (moved.current && event.detail !== 0) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <svg width={layout.width} height={layout.height} role="group" aria-label="Timeline of due dates by course" className="swimlane">
        {layout.ticks.map((tick) => (
          <g key={tick.date.toISOString()}>
            <line x1={tick.x} x2={tick.x} y1={48} y2={layout.height} className="swimlane-grid" />
            <text x={tick.x + 4} y={29} className="swimlane-axis">
              {compactDate(tick.date, zone)}
            </text>
          </g>
        ))}
        {lanes.map((lane, index) => (
          <text
            key={lane.id}
            x={16}
            y={laneY(index) + 5}
            className="swimlane-course"
            role="link"
            tabIndex={0}
            onClick={() => navigate(`/courses/${lane.id}`)}
            onKeyDown={(event) => activate(event, () => navigate(`/courses/${lane.id}`))}
          >
            {lane.label}
          </text>
        ))}
        {layout.laneLines.map((line) => (
          <line key={line.id} x1={line.x1} x2={line.x2} y1={line.y} y2={line.y} className="swimlane-line" />
        ))}
        {layout.nowX !== null ? (
          <g className="swimlane-now" aria-hidden="true">
            <line x1={layout.nowX} x2={layout.nowX} y1={42} y2={layout.height} />
            <rect x={layout.nowX - 21} y={7} width={42} height={23} rx={11} />
            <text x={layout.nowX} y={23}>
              Now
            </text>
          </g>
        ) : null}
        {layout.nodes.map((node) => {
          const label = `${node.task.title}, ${formatTaskDue(node.task, now, zone)}, ${submissionLabel(node.task)}`;
          return (
            <g
              key={node.task.id}
              className={`swimlane-node state-${node.task.state}`}
              tabIndex={0}
              role="link"
              aria-label={label}
              onClick={() => openTask(node.task)}
              onKeyDown={(event) => activate(event, () => openTask(node.task))}
            >
              <title>{`${node.task.title}\n${formatTaskDue(node.task, now, zone)}\n${submissionLabel(node.task)}`}</title>
              <circle cx={node.x} cy={node.y} r={9} />
              <text x={node.x + 14} y={node.labelY}>
                {shortTitle(node.task.title)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
