"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  Task,
  addTaskCache,
  api,
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
  font: "inherit",
  color: "var(--color-text)",
  caretColor: "var(--color-accent)",
};

function useAddRow(forToday: boolean) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  async function save(): Promise<boolean> {
    const t = title.trim();
    if (!t) return false;
    // Show the row immediately; the temp task is swapped for the server's
    // (real id) when the POST returns, or removed if it fails.
    const temp = makeTempTask({ title: t, today_flag: forToday });
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
        <span style={{ width: 18, height: 18, border: "1.5px dashed var(--color-divider)", flex: "none" }} />
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
      <span style={{ width: 18, height: 18, border: "1.5px dashed var(--color-accent-400)", flex: "none" }} />
      <input
        autoFocus
        placeholder="Task title"
        style={{ ...bareInput, fontSize: 14, fontWeight: 500 }}
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
        style={{ ...bareInput, fontSize: 14, fontWeight: 500 }}
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
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
          tabIndex={-1}
          aria-label="Due date and time"
        />
      </button>
    </div>
  );
}
