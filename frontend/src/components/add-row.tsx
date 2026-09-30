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
import { cn } from "@/lib/utils";
import { CalendarIcon, PlusIcon } from "./industry";
import { revalidateAll } from "./task-drawer";

/* Bare input styled to read as a task row, not a form control. Line height
   is inherited to match the collapsed row's text line, so opening the row
   doesn't change its height. 16px on phones stops iOS focus zoom. */
const bareInput =
  "min-w-0 flex-1 border-none bg-transparent p-0 text-[14px] leading-[inherit] font-medium text-ink caret-accent outline-none phone:text-[16px]";

/* Row shell shared by the collapsed and open states. */
const addRow = "flex items-center gap-2.5 border-b border-divider py-row-y pr-row-r pl-row-l";
const addRowCollapsed = cn(addRow, "cursor-text text-neutral-500 hover:bg-accent-100");
const addRowOpen = cn(addRow, "bg-accent-100");

/* Placeholder checkbox for the today add-row. Drawn as SVG because iOS
   Safari's dashed-border renderer drops the short left/right edges of an
   18px box entirely. */
function DashedSquare({ color }: { color: string }) {
  return (
    <svg width="18" height="18" className="flex-none" aria-hidden="true">
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
      backlog_origin: !forToday,
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
      <div className={addRowCollapsed} onClick={() => row.setOpen(true)}>
        <PlusIcon />
        <DashedSquare color="var(--color-divider)" />
        <span className="text-[14px]">Add a task…</span>
      </div>
    );
  }

  return (
    <div className={addRowOpen}>
      <PlusIcon stroke="var(--color-accent-700)" />
      <DashedSquare color="var(--color-accent-400)" />
      <input
        autoFocus
        placeholder="Task title"
        className={bareInput}
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
    const temp = makeTempTask({ title: t, deadline: d || null, backlog_origin: true });
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
      <div className={addRowCollapsed} onClick={() => setOpen(true)}>
        <PlusIcon />
        <span className="text-[14px]">Add a task…</span>
      </div>
    );
  }

  return (
    <div
      className={addRowOpen}
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
        className={bareInput}
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
          // Opening the picker on an empty due defaults it to today 11:59 PM,
          // so the calendar opens there and that is what sticks unless the
          // user picks otherwise. Set the DOM value too: showPicker() runs
          // before React re-renders with the new state.
          if (!due) {
            const def = endOfTodayDeadline();
            el.value = def;
            setDue(def);
          }
          try {
            el.showPicker();
          } catch {
            el.focus();
          }
        }}
        // Taller than the 14px text line; the negative margin keeps its
        // painted size while stopping it from stretching the row open.
        className={cn(
          "relative -my-[3px] inline-flex cursor-pointer items-center gap-1 border border-accent px-2 py-0.5 text-[12px] whitespace-nowrap",
          due ? "bg-accent text-canvas" : "bg-canvas text-accent"
        )}
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
          className="absolute inset-0 opacity-0 phone:text-[16px]"
          tabIndex={-1}
          aria-label="Due date and time"
        />
      </button>
    </div>
  );
}
