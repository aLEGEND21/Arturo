"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  Effort,
  Task,
  TaskEvent,
  addToTodayCache,
  api,
  fetcher,
  endOfTodayDeadline,
  fmtDue,
  logicalDay,
  patchTaskCache,
  removeFromTodayCache,
  revalidateAll,
} from "@/lib/api";
import { buttonClass, inputClass, kickerClass } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { Blueprint, Button, CheckIcon, CloseIcon, Field, Seg, Tag } from "./industry";

export { revalidateAll };

function eventLine(e: TaskEvent): string {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "state_changed":
      return `state_changed — ${String(p.to ?? "").replace("_", " ")}`;
    case "promoted":
      return `promoted — ${String(p.reason ?? "to today")}`;
    case "deferred":
      return `deferred — ${String(p.reason ?? p.source ?? "")}`;
    case "created":
      return `created — via ${String(p.source ?? "dashboard")}`;
    case "committed":
      return `committed — ${fmtDue(String(p.at)) ?? ""}`;
    case "carried_over":
      return "carried over — stayed on today";
    default:
      return e.event_type;
  }
}

function fmtEventDate(iso: string): string {
  const d = new Date(iso);
  const sameDay = logicalDay(d).getTime() === logicalDay().getTime();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export function TaskDrawer({
  task,
  onClose,
}: {
  task: Task | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  // Typing live-patches task.title/notes in the list caches, so the last
  // values actually persisted to the server have to be tracked separately.
  const [savedTitle, setSavedTitle] = useState("");
  const [savedNotes, setSavedNotes] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const dueInputRef = useRef<HTMLInputElement>(null);
  // Title and notes save on blur; Escape closes without blurring, so the key
  // handler needs the latest drafts to flush them.
  const titleRef = useRef(title);
  const notesRef = useRef(notes);
  useEffect(() => {
    titleRef.current = title;
    notesRef.current = notes;
  }, [title, notes]);

  // Reset form state when a different task opens (render-time adjustment,
  // per react.dev "you might not need an effect").
  if (task && task.id !== editingId) {
    setEditingId(task.id);
    setTitle(task.title);
    setSavedTitle(task.title);
    setNotes(task.notes ?? "");
    setSavedNotes(task.notes ?? "");
  } else if (!task && editingId !== null) {
    setEditingId(null);
  }

  const { data: events } = useSWR<TaskEvent[]>(
    task ? `/api/tasks/${task.id}/events` : null,
    fetcher
  );

  useEffect(() => {
    if (!task) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || !task) return;
      const fields: Record<string, unknown> = {};
      const titleDraft = titleRef.current.trim();
      if (titleDraft && titleDraft !== savedTitle) fields.title = titleDraft;
      // A blank title never saves; undo its live cache patch instead.
      else if (!titleDraft) patchTaskCache(task.id, { title: savedTitle });
      const notesDraft = notesRef.current;
      if (notesDraft !== savedNotes) fields.notes = notesDraft || null;
      if (Object.keys(fields).length) {
        api(`/api/tasks/${task.id}`, "PATCH", fields)
          .then(() => revalidateAll())
          .catch((err) =>
            toast.error(err instanceof Error ? err.message : "Update failed")
          );
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [task, onClose, savedTitle, savedNotes]);

  if (!task) return null;

  async function patch(fields: Record<string, unknown>, close = false) {
    if (!task) return;
    // Apply optimistically, mirroring the server's side effects: done stamps
    // completed_at, leaving done clears it, dropping leaves the today list.
    const opt = { ...fields } as Partial<Task>;
    if (opt.state === "done") opt.completed_at = new Date().toISOString();
    else if (opt.state !== undefined && task.state === "done") opt.completed_at = null;
    if (opt.state === "dropped") opt.today_flag = false;
    patchTaskCache(task.id, opt);
    // The today view is server-filtered, so rows it no longer matches must
    // be evicted rather than just patched, and newly promoted ones added.
    if (opt.today_flag === false) removeFromTodayCache(task.id);
    if (opt.today_flag === true) addToTodayCache({ ...task, ...opt });
    if (close) onClose();
    try {
      await api(`/api/tasks/${task.id}`, "PATCH", fields);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      revalidateAll();
    }
  }

  function saveTitle() {
    if (!task) return;
    const t = title.trim();
    if (!t) {
      // Blank reverts, never saves.
      setTitle(savedTitle);
      patchTaskCache(task.id, { title: savedTitle });
      return;
    }
    if (t !== savedTitle) {
      patch({ title: t });
      setSavedTitle(t);
    }
  }

  // datetime-local wants "YYYY-MM-DDTHH:MM"; deadlines may be date-only.
  // With no deadline yet, seed the picker at today 11:59 PM instead of "now".
  const dueValue = (() => {
    if (!task.deadline) return endOfTodayDeadline();
    return task.deadline.length === 10
      ? `${task.deadline}T00:00`
      : task.deadline.slice(0, 16);
  })();

  const dueLabel = (() => {
    if (!task.deadline) return null;
    const dateOnly = task.deadline.length === 10;
    const d = new Date(dateOnly ? `${task.deadline}T00:00:00` : task.deadline);
    if (isNaN(d.getTime())) return task.deadline;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit" }),
    });
  })();

  const effortSeg = (
    <Seg
      name="drawer-effort"
      value={(task.effort ?? "") as Effort}
      onChange={(v) => patch({ effort: v })}
      onDeselect={() => patch({ effort: null })}
      stretch
      options={[
        { value: "short", label: "Short" },
        { value: "medium", label: "Medium" },
        { value: "long", label: "Long" },
      ]}
    />
  );

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-40 bg-scrim" />
      <Blueprint className="fixed top-2.5 right-2.5 bottom-2.5 z-50 flex w-[min(480px,calc(100vw_-_20px))] animate-drawer-in flex-col shadow-lg">
        <div className="border-b border-divider px-5 pt-[18px] pb-3.5">
          <div className="flex items-start gap-2.5">
            <div className="flex-1">
              <div className={kickerClass}>Task #{task.id}</div>
              {/* Reads as the h4 heading; only the caret betrays it's editable. */}
              <input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  const t = e.target.value.trim();
                  if (t) patchTaskCache(task.id, { title: t });
                }}
                onBlur={saveTitle}
                aria-label="Task title"
                className="mt-1 block w-full border-none bg-transparent p-0 font-heading text-[20px] leading-[1.12] font-semibold tracking-[-0.015em] text-ink caret-accent outline-none"
              />
            </div>
            <Button size="icon" onClick={onClose} aria-label="Close">
              <CloseIcon />
            </Button>
          </div>
          {task.recurring || task.nudge_level > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {task.recurring ? <Tag tone="neutral">recurring · {task.streak}-day streak</Tag> : null}
              {task.nudge_level > 0 ? <Tag tone="neutral">nudge level {task.nudge_level}</Tag> : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          <Field label="State">
            <Seg
              name="drawer-state"
              value={task.state}
              onChange={(v) => patch({ state: v })}
              stretch
              options={[
                { value: "not_started", label: "Not started" },
                { value: "in_progress", label: "In progress" },
                { value: "done", label: "Done" },
              ]}
            />
          </Field>
          {/* Recurring tasks reset daily: no due date, so effort gets its own row. */}
          {task.recurring ? <Field label="Effort">{effortSeg}</Field> : null}

          {!task.recurring ? (
            <div className="flex gap-3.5">
              <Field label="Due" className="flex-1">
                <div
                  className={cn(
                    inputClass,
                    "relative flex cursor-pointer items-center gap-2",
                    dueLabel ? "text-ink" : "text-neutral-500"
                  )}
                  onClick={() => {
                    const el = dueInputRef.current;
                    if (!el) return;
                    try {
                      el.showPicker();
                    } catch {
                      el.focus();
                    }
                  }}
                >
                  <span className="flex-1 whitespace-nowrap">{dueLabel ?? "Set due date…"}</span>
                  {dueLabel ? (
                    <button
                      type="button"
                      aria-label="Clear due date"
                      // Above the transparent date input overlay so it stays clickable.
                      className={buttonClass({ variant: "ghost", className: "relative z-[1] px-1 py-0 text-[12px]" })}
                      onClick={(e) => {
                        e.stopPropagation();
                        patch({ deadline: null });
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                  <input
                    ref={dueInputRef}
                    type="datetime-local"
                    value={dueValue}
                    onChange={(e) => patch({ deadline: e.target.value || null })}
                    // Taps must reach the input itself: iOS Safari has no
                    // showPicker() for date inputs, but a direct tap on the
                    // transparent overlay opens the native picker. On desktop
                    // the click bubbles to the wrapper's showPicker() call.
                    className="absolute inset-0 opacity-0 phone:text-[16px]"
                    tabIndex={-1}
                    aria-label="Due date and time"
                  />
                </div>
              </Field>
              <Field label="Effort" className="flex-1">
                {effortSeg}
              </Field>
            </div>
          ) : null}

          <Field label="Notes — task content">
            <textarea
              className={cn(inputClass, "min-h-[56px] resize-y")}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                patchTaskCache(task.id, { notes: e.target.value || null });
              }}
              onBlur={() => {
                if (notes !== savedNotes) {
                  patch({ notes: notes || null });
                  setSavedNotes(notes);
                }
              }}
            />
          </Field>

          <div>
            <h6 className="mt-0 mr-0 mb-2 ml-0 text-muted">Event history</h6>
            <div className="flex flex-col text-[12.5px]">
              {(events ?? []).map((e, i) => (
                <div
                  key={e.id}
                  className={cn(
                    "flex gap-2.5 py-1.5",
                    i !== (events ?? []).length - 1 && "border-b border-divider-soft"
                  )}
                >
                  <span className="w-[120px] flex-none text-muted">{fmtEventDate(e.created_at)}</span>
                  <span>{eventLine(e)}</span>
                </div>
              ))}
              {(events ?? []).length === 0 ? <span className="text-muted">No events yet.</span> : null}
            </div>
          </div>
        </div>

        <div className="flex gap-2 border-t border-divider px-5 py-3.5">
          <Button variant="primary" onClick={() => patch({ state: "done" }, true)}>
            <CheckIcon />
            Mark done
          </Button>
          {task.today_flag ? (
            <Button
              onClick={() => {
                patch({ today_flag: false }, true);
                toast("Moved off today");
              }}
            >
              Not today
            </Button>
          ) : null}
          {!task.today_flag && !task.recurring && task.state !== "done" && task.state !== "dropped" ? (
            <Button
              onClick={() => {
                patch({ today_flag: true }, true);
                toast("Added to today");
              }}
            >
              Add to today
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            variant="ghost"
            className="text-neutral-600"
            onClick={() => {
              patch({ state: "dropped" }, true);
              toast("Task dropped");
            }}
          >
            Drop
          </Button>
        </div>
      </Blueprint>
    </>
  );
}
