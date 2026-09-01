import { mutate as swrMutate } from "swr";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export function revalidateAll() {
  swrMutate((key) => typeof key === "string" && key.startsWith("/api/"));
}

// Optimistically patch one task in every cached task list, without refetching.
// Used for live-preview edits (e.g. typing a note) before the PATCH lands.
export function patchTaskCache(id: number, fields: Partial<Task>) {
  swrMutate(
    (key) => typeof key === "string" && key.startsWith("/api/tasks?"),
    (curr: Task[] | undefined) =>
      curr ? curr.map((t) => (t.id === id ? { ...t, ...fields } : t)) : curr,
    { revalidate: false }
  );
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

export function formatDeadline(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (isNaN(d.getTime())) return iso;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
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
