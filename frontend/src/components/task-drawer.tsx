"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  Effort,
  Task,
  TaskEvent,
  api,
  fetcher,
  fmtDue,
  logicalDay,
  patchTaskCache,
  removeFromTodayCache,
  revalidateAll,
} from "@/lib/api";
import { Blueprint, CheckIcon, CloseIcon, Seg } from "./industry";

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
  // Typing live-patches task.notes in the list caches, so the last value
  // actually persisted to the server has to be tracked separately.
  const [savedNotes, setSavedNotes] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const dueInputRef = useRef<HTMLInputElement>(null);
  // Notes save on blur; Escape closes without blurring, so the key handler
  // needs the latest draft to flush it.
  const notesRef = useRef(notes);
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  // Reset form state when a different task opens (render-time adjustment,
  // per react.dev "you might not need an effect").
  if (task && task.id !== editingId) {
    setEditingId(task.id);
    setTitle(task.title);
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
      const draft = notesRef.current;
      if (draft !== savedNotes) {
        api(`/api/tasks/${task.id}`, "PATCH", { notes: draft || null })
          .then(() => revalidateAll())
          .catch((err) =>
            toast.error(err instanceof Error ? err.message : "Update failed")
          );
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [task, onClose, savedNotes]);

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
    // be evicted rather than just patched.
    if (opt.today_flag === false) removeFromTodayCache(task.id);
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
      setTitle(task.title); // blank reverts, never saves
      return;
    }
    if (t !== task.title) patch({ title: t });
  }

  // datetime-local wants "YYYY-MM-DDTHH:MM"; deadlines may be date-only.
  // With no deadline yet, seed the picker at today 11:59 PM instead of "now".
  // Calendar today on purpose: at 1am the logical day's 11:59 PM is already past.
  const dueValue = (() => {
    if (!task.deadline) {
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return `${iso}T23:59`;
    }
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

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 40,
          background: "color-mix(in srgb, var(--color-neutral-900) 22%, transparent)",
        }}
      />
      <Blueprint
        style={{
          position: "fixed",
          top: 10,
          right: 10,
          bottom: 10,
          width: "min(480px, calc(100vw - 20px))",
          zIndex: 50,
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          animation: "drawer-in 0.2s ease-out",
        }}
      >
        <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--color-divider)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div className="card-kicker">Task #{task.id}</div>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                aria-label="Task title"
                style={{
                  // Reads as the h4 heading; only the caret betrays it's editable.
                  display: "block",
                  width: "100%",
                  margin: "4px 0 0",
                  padding: 0,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontFamily: "var(--font-heading)",
                  fontWeight: "var(--font-heading-weight)" as React.CSSProperties["fontWeight"],
                  fontSize: 20,
                  lineHeight: 1.12,
                  letterSpacing: "-0.015em",
                  color: "var(--color-text)",
                  caretColor: "var(--color-accent)",
                }}
              />
            </div>
            <button className="btn btn-icon btn-secondary" onClick={onClose} aria-label="Close">
              <CloseIcon />
            </button>
          </div>
          {task.recurring || task.nudge_level > 0 ? (
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              {task.recurring ? <span className="tag tag-neutral">recurring · {task.streak}-day streak</span> : null}
              {task.nudge_level > 0 ? <span className="tag tag-neutral">nudge level {task.nudge_level}</span> : null}
            </div>
          ) : null}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="field">
            <label>State</label>
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
          </div>
          {/* Recurring tasks reset daily: no due date, so effort gets its own row. */}
          {task.recurring ? (
            <div className="field">
              <label>Effort</label>
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
            </div>
          ) : null}

          {!task.recurring ? (
          <div style={{ display: "flex", gap: 14 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Due</label>
              <div
                className="input"
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  color: dueLabel ? "var(--color-text)" : "var(--color-neutral-500)",
                }}
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
                <span style={{ flex: 1, whiteSpace: "nowrap" }}>
                  {dueLabel ?? "Set due date…"}
                </span>
                {dueLabel ? (
                  <button
                    type="button"
                    aria-label="Clear due date"
                    className="btn btn-ghost"
                    // Above the transparent date input overlay so it stays clickable.
                    style={{ padding: "0 4px", fontSize: 12, position: "relative", zIndex: 1 }}
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
                  style={{ position: "absolute", inset: 0, opacity: 0 }}
                  tabIndex={-1}
                  aria-label="Due date and time"
                />
              </div>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Effort</label>
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
            </div>
          </div>
          ) : null}

          <div className="field">
            <label>Notes — task content</label>
            <textarea
              className="input"
              style={{ minHeight: 56 }}
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
          </div>

          <div>
            <h6 className="text-muted" style={{ margin: "0 0 8px" }}>Event history</h6>
            <div style={{ display: "flex", flexDirection: "column", fontSize: 12.5 }}>
              {(events ?? []).map((e, i) => (
                <div
                  key={e.id}
                  style={{
                    display: "flex",
                    gap: 10,
                    padding: "6px 0",
                    borderBottom:
                      i === (events ?? []).length - 1
                        ? "none"
                        : "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)",
                  }}
                >
                  <span className="text-muted" style={{ width: 120, flex: "none" }}>
                    {fmtEventDate(e.created_at)}
                  </span>
                  <span>{eventLine(e)}</span>
                </div>
              ))}
              {(events ?? []).length === 0 ? (
                <span className="text-muted">No events yet.</span>
              ) : null}
            </div>
          </div>
        </div>

        <div style={{ padding: "14px 20px", borderTop: "1px solid var(--color-divider)", display: "flex", gap: 8 }}>
          <button
            className="btn btn-primary"
            style={{ display: "inline-flex", gap: 6 }}
            onClick={() => patch({ state: "done" }, true)}
          >
            <CheckIcon />
            Mark done
          </button>
          {task.today_flag ? (
            <button
              className="btn btn-secondary"
              onClick={() => {
                patch({ today_flag: false }, true);
                toast("Moved off today");
              }}
            >
              Not today
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button
            className="btn btn-ghost"
            style={{ color: "var(--color-neutral-600)" }}
            onClick={() => {
              patch({ state: "dropped" }, true);
              toast("Task dropped");
            }}
          >
            Drop
          </button>
        </div>
      </Blueprint>
    </>
  );
}
