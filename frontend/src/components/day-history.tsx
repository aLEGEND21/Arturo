"use client";

import { HistoryTask, fmtTime } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Blueprint, Square } from "./industry";
import { rowPadding, rowSubline, rowTitle } from "./task-row";

function statusLabel(t: HistoryTask): { text: string; tone: "muted" | "accent" } {
  switch (t.status) {
    case "done":
      return { text: t.completed_at ? `Done ${fmtTime(t.completed_at)}` : "Done", tone: "muted" };
    case "not_finished":
      return { text: "Not finished", tone: "accent" };
    case "missed":
      return { text: "Missed", tone: "accent" };
  }
}

function HistoryRow({ task, isLast }: { task: HistoryTask; isLast: boolean }) {
  const done = task.status === "done";
  const label = statusLabel(task);
  return (
    <div className={cn("flex items-center gap-2.5", rowPadding, !isLast && "border-b border-divider")}>
      <Square checked={done} />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            rowTitle,
            done ? "font-normal text-neutral-500 line-through" : "font-medium"
          )}
        >
          {task.title}
        </div>
        {task.notes ? (
          <div className={rowSubline}>{task.notes.replace(/\s+/g, " ").trim()}</div>
        ) : null}
      </div>
      <span
        className={cn(
          "text-[12px] whitespace-nowrap",
          label.tone === "accent" ? "font-medium text-accent-700" : "text-muted"
        )}
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
          <div className="p-row-x text-[13px] text-muted">
            No task activity on this day.
          </div>
        ) : null}
      </Blueprint>

      {recurring.length > 0 ? (
        <div className="mt-3">
          <h6 className="mt-0 mr-0 mb-2 ml-0 text-muted">
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
