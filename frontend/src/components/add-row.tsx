"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  Task,
  addTaskCache,
  api,
  endOfTodayDeadline,
  fmtDue,
  makeTempTask,
  removeTaskCache,
  replaceTaskCache,
} from "@/lib/api";
import { CalendarIcon, PlusIcon } from "./industry";
import { revalidateAll } from "./task-drawer";

/* Bare input styled to read as a task row, not a form control. */
const bareInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "none",
  outline: "none",
  padding: 0,
  // Not the `font` shorthand: it would pin font-size inline, beating the
  // .add-input mobile override (16px stops iOS focus zoom).
  fontFamily: "inherit",
  // Match the collapsed row's text line so opening the row doesn't change
  // its height (inputs default to line-height: normal, which is shorter).
  lineHeight: "inherit",
  color: "var(--color-text)",
  caretColor: "var(--color-accent)",
};

/* Placeholder checkbox for the today add-row. Drawn as SVG because iOS
   Safari's dashed-border renderer drops the short left/right edges of an
   18px box entirely. */
function DashedSquare({ color }: { color: string }) {
  return (
    <svg width="18" height="18" style={{ flex: "none" }} aria-hidden="true">
      <rect
        x="0.75"
        y="0.75"
        width="16.5"
        height="16.5"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeDasharray="3 3"
      />
    </svg>
  );
}

function useAddRow(forToday: boolean) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  async function save(): Promise<boolean> {
    const t = title.trim();
    if (!t) return false;
    // Show the row immediately; the temp task is swapped for the server's
    // (real id) when the POST returns, or removed if it fails.
    const temp = makeTempTask({
      title: t,
      today_flag: forToday,
      deadline: forToday ? endOfTodayDeadline() : null,
    });
    addTaskCache(temp);
    setTitle("");
    try {
      const created = await api<Task>("/api/tasks", "POST", { title: t, today: forToday });
      replaceTaskCache(temp.id, created);
      revalidateAll();
      return true;
    } catch (e) {
      removeTaskCache(temp.id);
      setTitle(t); // don't lose the typed title on failure
      toast.error(e instanceof Error ? e.message : "Add failed");
      return false;
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      // Save and stay open so several tasks can be typed in a row.
      save();
    } else if (e.key === "Escape") {
      setTitle("");
      setOpen(false);
    }
  }

  async function onBlur() {
    const ok = await save();
    // A failed save restores the draft title — keep the row open so it
    // isn't lost; otherwise clear and close as usual.
    if (!ok && title.trim()) return;
    setTitle("");
    setOpen(false);
  }

  return { open, setOpen, title, setTitle, onKeyDown, onBlur };
}

export function TodayAddRow() {
  const row = useAddRow(true);

  if (!row.open) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 14px",
          borderBottom: "1px solid var(--color-divider)",
          cursor: "text",
          color: "var(--color-neutral-500)",
        }}
        onClick={() => row.setOpen(true)}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-accent-100)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "")}
      >
        <PlusIcon />
        <DashedSquare color="var(--color-divider)" />
        <span style={{ fontSize: 14 }}>Add a task…</span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        borderBottom: "1px solid var(--color-divider)",
        background: "var(--color-accent-100)",
      }}
    >
      <PlusIcon stroke="var(--color-accent-700)" />
      <DashedSquare color="var(--color-accent-400)" />
      <input
        autoFocus
        placeholder="Task title"
        className="add-input"
        style={{ ...bareInput, fontWeight: 500 }}
        value={row.title}
        onChange={(e) => row.setTitle(e.target.value)}
        onKeyDown={row.onKeyDown}
        onBlur={row.onBlur}
      />
    </div>
  );
}

export function BacklogAddRow() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const dueRef = useRef<HTMLInputElement>(null);

  async function save(): Promise<boolean> {
    const t = title.trim();
    if (!t) return false;
    const d = due;
    const temp = makeTempTask({ title: t, deadline: d || null });
    addTaskCache(temp);
    setTitle("");
    setDue("");
    try {
      const created = await api<Task>("/api/tasks", "POST", {
        title: t,
        deadline: d || null,
        today: false,
      });
      replaceTaskCache(temp.id, created);
      revalidateAll();
      return true;
    } catch (e) {
      removeTaskCache(temp.id);
      setTitle(t); // don't lose the typed title on failure
      setDue(d);
      toast.error(e instanceof Error ? e.message : "Add failed");
      return false;
    }
  }

  function close() {
    setTitle("");
    setDue("");
    setOpen(false);
  }

  if (!open) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 14px",
          borderBottom: "1px solid var(--color-divider)",
          cursor: "text",
          color: "var(--color-neutral-500)",
        }}
        onClick={() => setOpen(true)}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-accent-100)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "")}
      >
        <PlusIcon />
        <span style={{ fontSize: 14 }}>Add a task…</span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        borderBottom: "1px solid var(--color-divider)",
        background: "var(--color-accent-100)",
      }}
      onBlur={async (e) => {
        // Save-and-close only when focus leaves the whole row, so the
        // calendar chip can be used without committing the task early.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        const ok = await save();
        // A failed save restores the draft — keep the row open in that case.
        if (ok || !title.trim()) close();
      }}
    >
      <PlusIcon stroke="var(--color-accent-700)" />
      <input
        autoFocus
        placeholder="Task title"
        className="add-input"
        style={{ ...bareInput, fontWeight: 500 }}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            save();
          } else if (e.key === "Escape") {
            close();
          }
        }}
      />
      <button
        type="button"
        onClick={() => {
          const el = dueRef.current;
          if (!el) return;
          try {
            el.showPicker();
          } catch {
            el.focus();
          }
        }}
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 12,
          padding: "2px 8px",
          // Taller than the 14px text line; the negative margin keeps its
          // painted size while stopping it from stretching the row open.
          margin: "-3px 0",
          border: "1px solid var(--color-accent)",
          color: due ? "var(--color-bg)" : "var(--color-accent)",
          background: due ? "var(--color-accent)" : "var(--color-bg)",
          cursor: "pointer",
          whiteSpace: "nowrap",
          fontFamily: "inherit",
        }}
      >
        <CalendarIcon />
        {due ? fmtDue(due) : "due"}
        <input
          ref={dueRef}
          type="datetime-local"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          // Taps must reach the input itself: iOS Safari has no showPicker()
          // for date inputs, but a direct tap on the transparent overlay
          // opens the native picker. On desktop the click bubbles to the
          // chip button's showPicker() call.
          style={{ position: "absolute", inset: 0, opacity: 0 }}
          tabIndex={-1}
          aria-label="Due date and time"
        />
      </button>
    </div>
  );
}
