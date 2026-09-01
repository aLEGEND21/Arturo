"use client";

import { HistoryTask, fmtTime } from "@/lib/api";
import { Blueprint, Square } from "./industry";

function statusLabel(t: HistoryTask): { text: string; tone: "muted" | "accent" } {
  switch (t.status) {
    case "done":
      return { text: t.completed_at ? `Done ${fmtTime(t.completed_at)}` : "Done", tone: "muted" };
    case "not_finished":
      return { text: "Not finished", tone: "accent" };
    case "missed":
      return { text: "Missed", tone: "accent" };
    case "removed":
      return { text: "Moved off", tone: "muted" };
    case "dropped":
      return { text: "Dropped", tone: "muted" };
  }
}

function HistoryRow({ task, isLast }: { task: HistoryTask; isLast: boolean }) {
  const done = task.status === "done";
  const label = statusLabel(task);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        borderBottom: isLast ? "none" : "1px solid var(--color-divider)",
      }}
    >
      <Square checked={done} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: done ? 400 : 500,
            textDecoration: done ? "line-through" : undefined,
            color: done ? "var(--color-neutral-500)" : undefined,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.title}
        </div>
        {task.notes ? (
          <div
            className="text-muted"
            style={{
              fontSize: 11.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {task.notes.replace(/\s+/g, " ").trim()}
          </div>
        ) : null}
      </div>
      <span
        className={label.tone === "muted" ? "text-muted" : undefined}
        style={{
          fontSize: 12,
          whiteSpace: "nowrap",
          ...(label.tone === "accent"
            ? { color: "var(--color-accent-700)", fontWeight: 500 }
            : {}),
        }}
      >
        {label.text}
      </span>
    </div>
  );
}

/* Read-only view of a past day, reconstructed from the event log. */
export function DayHistoryBoards({ tasks }: { tasks: HistoryTask[] }) {
  const regular = tasks.filter((t) => !t.recurring);
  const recurring = tasks.filter((t) => t.recurring);
  return (
    <>
      <Blueprint>
        {regular.map((t, i) => (
          <HistoryRow key={t.id} task={t} isLast={i === regular.length - 1} />
        ))}
        {regular.length === 0 ? (
          <div className="text-muted" style={{ padding: 14, fontSize: 13 }}>
            No task activity on this day.
          </div>
        ) : null}
      </Blueprint>

      {recurring.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <h6 className="text-muted" style={{ margin: "0 0 8px" }}>
            Recurring
          </h6>
          <Blueprint>
            {recurring.map((t, i) => (
              <HistoryRow key={t.id} task={t} isLast={i === recurring.length - 1} />
            ))}
          </Blueprint>
        </div>
      ) : null}
    </>
  );
}
