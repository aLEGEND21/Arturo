import { mutate as swrMutate } from "swr";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export function revalidateAll() {
  swrMutate((key) => typeof key === "string" && key.startsWith("/api/"));
}

// Optimistically patch one task in every cached task list, without refetching.
// Used to reflect edits (state toggles, drawer fields, note typing) before the
// PATCH lands; callers revalidate afterwards to sync server-computed fields.
export function patchTaskCache(id: number, fields: Partial<Task>) {
  swrMutate(
    (key) => typeof key === "string" && key.startsWith("/api/tasks?"),
    (curr: Task[] | undefined) =>
      curr ? curr.map((t) => (t.id === id ? { ...t, ...fields } : t)) : curr,
    { revalidate: false }
  );
}

// Mirror of the server's placement for a task created on the today list:
// the top, except that open today tasks due sooner stay above it. Deadlines
// are naive local strings, so lexical order is chronological; no deadline
// counts as due last. Every cached list is ordered by position, so inserting
// before the same anchor row keeps them consistent until revalidation.
function insertForToday(curr: Task[], task: Task): Task[] {
  const at = curr.findIndex((t) => {
    if (t.recurring || !t.today_flag || t.state === "done" || t.state === "dropped") return false;
    const sooner = t.deadline !== null && (task.deadline === null || t.deadline < task.deadline);
    return !sooner;
  });
  return at === -1 ? [...curr, task] : [...curr.slice(0, at), task, ...curr.slice(at)];
}

// Optimistically add a (usually temporary) task to the cached lists it
// belongs in: the today view only shows today-flagged tasks. Backlog tasks
// append; today tasks slot in where the server will put them.
export function addTaskCache(task: Task) {
  const placeForToday = task.today_flag && !task.recurring;
  swrMutate(
    (key) =>
      typeof key === "string" &&
      key.startsWith("/api/tasks?") &&
      (task.today_flag || !key.includes("view=today")),
    (curr: Task[] | undefined) =>
      curr ? (placeForToday ? insertForToday(curr, task) : [...curr, task]) : curr,
    { revalidate: false }
  );
}

// Swap a temporary task for the server-created one (real id) in every list.
export function replaceTaskCache(tempId: number, task: Task) {
  swrMutate(
    (key) => typeof key === "string" && key.startsWith("/api/tasks?"),
    (curr: Task[] | undefined) => curr?.map((t) => (t.id === tempId ? task : t)),
    { revalidate: false }
  );
}

export function removeTaskCache(id: number) {
  swrMutate(
    (key) => typeof key === "string" && key.startsWith("/api/tasks?"),
    (curr: Task[] | undefined) => curr?.filter((t) => t.id !== id),
    { revalidate: false }
  );
}

// Mirror of removeFromTodayCache: a task promoted from the backlog is not in
// the today cache yet, so patching it there does nothing. Insert it (once)
// where the server will place it so it shows before revalidation.
export function addToTodayCache(task: Task) {
  swrMutate(
    (key) => typeof key === "string" && key.includes("view=today"),
    (curr: Task[] | undefined) =>
      curr && !curr.some((t) => t.id === task.id) ? insertForToday(curr, task) : curr,
    { revalidate: false }
  );
}

// The today view is server-filtered (today_flag = 1, not dropped), so patching
// those fields isn't enough — the row must leave the today cache too.
export function removeFromTodayCache(id: number) {
  swrMutate(
    (key) => typeof key === "string" && key.includes("view=today"),
    (curr: Task[] | undefined) => curr?.filter((t) => t.id !== id),
    { revalidate: false }
  );
}

// Placeholder for optimistic task creation: negative id so it can't collide
// with a real one, max position so it sorts last where lists sort by position
// (addTaskCache places today tasks by list order, not position).
let tempTaskSeq = -1;
export function makeTempTask(fields: Partial<Task>): Task {
  return {
    id: tempTaskSeq--,
    title: "",
    notes: null,
    handling: null,
    position: Number.MAX_SAFE_INTEGER,
    starred: false,
    recurring: false,
    streak: 0,
    board_id: null,
    deadline: null,
    commitment_at: null,
    effort: null,
    state: "not_started",
    blocked_reason: null,
    today_flag: false,
    backlog_origin: false,
    snooze_until: null,
    snooze_reason: null,
    nudge_level: 0,
    last_user_update: null,
    source: "dashboard",
    created_at: new Date().toISOString(),
    completed_at: null,
    ...fields,
  };
}

export type Effort = "short" | "medium" | "long";
export type TaskState =
  | "not_started"
  | "in_progress"
  | "blocked"
  | "done"
  | "dropped";

export interface Task {
  id: number;
  title: string;
  notes: string | null;
  handling: string | null;
  position: number;
  starred: boolean;
  recurring: boolean;
  streak: number;
  board_id: number | null;
  deadline: string | null;
  commitment_at: string | null;
  effort: Effort | null;
  state: TaskState;
  blocked_reason: string | null;
  today_flag: boolean;
  /** Created on the all-tasks list (not today). Fixed at creation. */
  backlog_origin: boolean;
  snooze_until: string | null;
  snooze_reason: string | null;
  nudge_level: number;
  last_user_update: string | null;
  source: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Board {
  id: number;
  name: string;
  color: string | null;
}

export interface Rule {
  id: number;
  text: string;
  active: boolean;
  created_at: string;
}

export interface ContextNote {
  id: number;
  scope: "global" | "task";
  task_id: number | null;
  text: string;
  expires_at: string | null;
  active: boolean;
  created_at: string;
}

export interface TaskEvent {
  id: number;
  task_id: number;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

// How a task that was still on the list at the end of a past day ended up.
// Tasks moved off or dropped during the day are not part of history.
export type DayStatus = "done" | "not_finished" | "missed";

export interface HistoryTask {
  id: number;
  title: string;
  notes: string | null;
  recurring: boolean;
  effort: Effort | null;
  streak: number;
  status: DayStatus;
  completed_at: string | null;
}

export interface DayHistory {
  date: string;
  tasks: HistoryTask[];
}

export interface StatsSummary {
  done_today: number;
  today_total: number;
  seven_day_avg: number;
  open_tasks: number;
}

export async function fetcher<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function api<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `API ${res.status}`;
    try {
      const j = await res.json();
      if (j.detail) detail = String(j.detail);
    } catch {
      /* keep default */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Working days end at the 4am rollover, not midnight (backend clock.py). */
export const DAY_START_HOUR = 4;

/**
 * Midnight of the logical day a moment belongs to. Before DAY_START_HOUR
 * that is the previous calendar date, so 1am still reads as "yesterday's"
 * working day. Defaults to now.
 */
export function logicalDay(at: Date = new Date()): Date {
  const d = new Date(at);
  d.setHours(d.getHours() - DAY_START_HOUR);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 11:59 PM today (calendar date) as a naive local "YYYY-MM-DDTHH:MM" string,
 *  the format the deadline picker saves. Tasks added to the today list default
 *  to this; the server does the same. */
export function endOfTodayDeadline(): string {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${iso}T23:59`;
}

export function formatDeadline(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (isNaN(d.getTime())) return iso;
  // Deadlines are calendar dates; "today" is the logical working day.
  const today = logicalDay();
  const that = new Date(d);
  that.setHours(0, 0, 0, 0);
  const diff = Math.round((that.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff < 0) return `${-diff}d overdue`;
  if (diff < 7)
    return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtDue(iso: string | null, withWeekday = false): string | null {
  if (!iso) return null;
  const dateOnly = iso.length === 10;
  const d = new Date(dateOnly ? `${iso}T00:00:00` : iso);
  if (isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    ...(withWeekday ? { weekday: "short" } : {}),
    ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit" }),
  };
  return d.toLocaleString(undefined, opts);
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function deadlineTone(iso: string | null): "overdue" | "soon" | "normal" {
  if (!iso) return "normal";
  const d = new Date(iso.length === 10 ? `${iso}T23:59:59` : iso);
  const now = new Date();
  if (d < now) return "overdue";
  if (d.getTime() - now.getTime() < 2 * 86400000) return "soon";
  return "normal";
}
