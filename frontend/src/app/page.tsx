"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { toast } from "sonner";
import {
  DayHistory,
  Task,
  api,
  deadlineTone,
  fetcher,
  fmtDue,
  logicalDay,
  patchTaskCache,
} from "@/lib/api";
import { BacklogAddRow, TodayAddRow } from "@/components/add-row";
import { DayHistoryBoards } from "@/components/day-history";
import { EffortDot } from "@/components/effort-dot";
import { ContextStrip } from "@/components/context-strip";
import { Blueprint, OverdueTag, Square } from "@/components/industry";
import { TaskDrawer, revalidateAll } from "@/components/task-drawer";
import { TodayBoards } from "@/components/today-list";

const TODAY_KEY = "/api/tasks?view=today";
const ALL_KEY = "/api/tasks?view=all";

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// useSearchParams needs a Suspense boundary during prerendering.
export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <Dashboard />
    </Suspense>
  );
}

function Dashboard() {
  const { data: todayTasks, error } = useSWR<Task[]>(TODAY_KEY, fetcher);
  const { data: allTasks } = useSWR<Task[]>(ALL_KEY, fetcher);
  const { mutate } = useSWRConfig();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // The browsed day lives in the URL (?day=YYYY-MM-DD) so it survives reloads
  // and can be shared. No param = today, so an open tab never goes stale at
  // the day boundary. Offset 0 = today; negative = past days (read-only).
  // "Today" is the logical working day (see logicalDay), which starts at
  // 4am to match the rollover job.
  const router = useRouter();
  const dayParam = useSearchParams().get("day");
  const dayOffset = useMemo(() => {
    if (!dayParam || !/^\d{4}-\d{2}-\d{2}$/.test(dayParam)) return 0;
    const target = new Date(`${dayParam}T00:00:00`);
    if (isNaN(target.getTime())) return 0;
    const today = logicalDay();
    return Math.min(0, Math.round((target.getTime() - today.getTime()) / 86400000));
  }, [dayParam]);

  function goToOffset(offset: number) {
    if (offset >= 0) {
      router.replace("/", { scroll: false });
      return;
    }
    const d = logicalDay();
    d.setDate(d.getDate() + offset);
    router.replace(`/?day=${localIso(d)}`, { scroll: false });
  }

  const recurring = (todayTasks ?? []).filter((t) => t.recurring);
  // Completed tasks sink to the bottom for display only. Stored positions are
  // untouched, so unchecking puts a task straight back where it was. A stable
  // partition (not a sort by position) keeps optimistic reorders intact.
  const regular = useMemo(() => {
    const list = (todayTasks ?? []).filter((t) => !t.recurring);
    return [...list.filter((t) => t.state !== "done"), ...list.filter((t) => t.state === "done")];
  }, [todayTasks]);
  const doneCount = regular.filter((t) => t.state === "done").length;

  const backlog = useMemo(() => {
    const list = (allTasks ?? []).filter(
      (t) => !t.recurring && !t.today_flag && t.state !== "done" && t.state !== "dropped"
    );
    list.sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return a.position - b.position;
    });
    return list;
  }, [allTasks]);

  // Only tasks born on this list. Tasks created on today (even if they visited
  // the backlog on the way) live on in day history instead. A backlog-born task
  // finished while on today shows here at once, alongside its today row; the
  // today flag is deliberately not a condition.
  const recentDone = useMemo(() => {
    const list = (allTasks ?? []).filter(
      (t) => t.backlog_origin && !t.recurring && t.state === "done" && t.completed_at
    );
    list.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    return list.slice(0, 5);
  }, [allTasks]);

  // Keep the drawer's task fresh across mutations.
  const selected =
    (todayTasks ?? []).find((t) => t.id === selectedId) ??
    (allTasks ?? []).find((t) => t.id === selectedId) ??
    null;

  async function toggleDone(task: Task) {
    const newState: Task["state"] = task.state === "done" ? "not_started" : "done";
    // Mirrors the server: done stamps completed_at, un-done clears it.
    patchTaskCache(task.id, {
      state: newState,
      completed_at: newState === "done" ? new Date().toISOString() : null,
    });
    try {
      await api(`/api/tasks/${task.id}`, "PATCH", { state: newState });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      revalidateAll();
    }
  }

  // Done tasks are shown at the bottom but keep their real positions, so they
  // must not take part in a reorder write or that display order would stick.
  function openIds(ids: number[], byId: Map<number, Task>, keep?: number): number[] {
    return ids.filter((id) => id === keep || byId.get(id)?.state !== "done");
  }

  async function reorderList(ids: number[], which: "regular" | "recurring") {
    const byId = new Map((todayTasks ?? []).map((t) => [t.id, t]));
    const moved = ids.map((id) => byId.get(id)!).filter(Boolean);
    const next = which === "regular" ? [...moved, ...recurring] : [...regular, ...moved];
    mutate(TODAY_KEY, next, { revalidate: false });
    try {
      await api("/api/tasks/reorder", "POST", {
        ids: which === "regular" ? openIds(ids, byId) : ids,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reorder failed");
      mutate(TODAY_KEY);
    }
  }

  async function crossMove(taskId: number, makeRecurring: boolean, orderedTargetIds: number[]) {
    const byId = new Map((todayTasks ?? []).map((t) => [t.id, t]));
    const moved = byId.get(taskId);
    if (!moved) return;
    const updated = { ...moved, recurring: makeRecurring };
    byId.set(taskId, updated);
    const targetList = orderedTargetIds.map((id) => byId.get(id)!).filter(Boolean);
    const otherList = (makeRecurring ? regular : recurring).filter((t) => t.id !== taskId);
    const next = makeRecurring ? [...otherList, ...targetList] : [...targetList, ...otherList];
    mutate(TODAY_KEY, next, { revalidate: false });
    try {
      await api(`/api/tasks/${taskId}`, "PATCH", { recurring: makeRecurring });
      await api("/api/tasks/reorder", "POST", {
        ids: makeRecurring ? orderedTargetIds : openIds(orderedTargetIds, byId, taskId),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
    } finally {
      revalidateAll();
    }
  }

  const viewDate = logicalDay();
  viewDate.setDate(viewDate.getDate() + dayOffset);
  const viewIso = localIso(viewDate);
  const { data: history } = useSWR<DayHistory>(
    dayOffset < 0 ? `/api/history/${viewIso}` : null,
    fetcher
  );

  const heading =
    dayOffset === 0
      ? "Today"
      : dayOffset === -1
        ? "Yesterday"
        : viewDate.toLocaleDateString(undefined, { weekday: "long" });
  const dateLabel = viewDate.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const histRegular = (history?.tasks ?? []).filter((t) => !t.recurring);
  const histDone = histRegular.filter((t) => t.status === "done").length;
  const histTotal = histRegular.filter(
    (t) => t.status === "done" || t.status === "not_finished"
  ).length;
  const shownDone = dayOffset === 0 ? doneCount : histDone;
  const shownTotal = dayOffset === 0 ? regular.length : histTotal;

  return (
    <div>
      <ContextStrip />

      {error ? (
        <div
          style={{
            margin: "14px var(--page-pad-x) 0",
            padding: "9px 14px",
            border: "1px solid var(--color-divider)",
            fontSize: 13,
          }}
        >
          Can&apos;t reach the API — is the backend running on port 8000?
        </div>
      ) : null}

      {/* Two columns; stacks Today above All tasks on small screens (globals.css) */}
      <div className="dashboard-grid">
        {/* — Today column — */}
        {/* minWidth 0 lets long nowrap notes truncate instead of widening the 1fr track */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              position: "relative",
            }}
          >
            <h3 style={{ margin: 0 }}>{heading}</h3>
            {/* Absolutely centered in the column so the arrows stay put no
                matter how wide the day name or counter is. */}
            <span
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
              }}
            >
              <DayArrow dir={-1} onClick={() => goToOffset(dayOffset - 1)} />
              <span
                className="text-muted"
                style={{ fontSize: 12, width: 76, textAlign: "center" }}
              >
                {dateLabel}
              </span>
              <DayArrow
                dir={1}
                disabled={dayOffset === 0}
                onClick={() => goToOffset(dayOffset + 1)}
              />
            </span>
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontFamily: "var(--font-heading)",
                fontWeight: 600,
                fontSize: 22,
                lineHeight: 1.12,
                color: "var(--color-accent-700)",
              }}
            >
              {shownDone}
              <span style={{ color: "var(--color-neutral-500)", fontSize: 16 }}>
                {" "}
                / {shownTotal} done
              </span>
            </span>
          </div>

          {dayOffset === 0 ? (
            <TodayBoards
              regular={regular}
              recurring={recurring}
              addRow={<TodayAddRow />}
              onToggleDone={toggleDone}
              onOpen={(t) => setSelectedId(t.id)}
              onReorderRegular={(ids) => reorderList(ids, "regular")}
              onReorderRecurring={(ids) => reorderList(ids, "recurring")}
              onCrossMove={crossMove}
            />
          ) : history ? (
            <DayHistoryBoards tasks={history.tasks} />
          ) : (
            <Blueprint>
              <div className="text-muted" style={{ padding: "var(--row-pad-x)", fontSize: 13 }}>
                Loading…
              </div>
            </Blueprint>
          )}
        </div>

        {/* — All tasks column — */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h3 style={{ margin: 0 }}>All tasks</h3>
            <span className="text-muted" style={{ fontSize: 12 }}>
              {backlog.length} open
            </span>
          </div>

          <Blueprint>
            <BacklogAddRow />
            {backlog.map((t, i) => {
              const tone = deadlineTone(t.deadline);
              const soon = tone !== "normal";
              return (
                <div
                  key={t.id}
                  className="task-row"
                  onClick={() => setSelectedId(t.id)}
                  style={{
                    // checkbox, text, effort dot
                    ["--row-cols" as string]: "auto 1fr auto",
                    ["--text-col" as string]: "2",
                    padding: "var(--row-pad-y) var(--row-pad-r) var(--row-pad-y) var(--row-pad-l)",
                    borderBottom:
                      i === backlog.length - 1 && recentDone.length === 0
                        ? "none"
                        : "1px solid var(--color-divider)",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-neutral-100)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  <Square
                    checked={t.state === "done"}
                    onToggle={() => toggleDone(t)}
                    label={`Mark "${t.title}" done`}
                  />
                  <div className="task-row-text" style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.title}
                    </div>
                    {t.notes ? (
                      <div
                        className="text-muted"
                        style={{
                          fontSize: 11.5,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t.notes.replace(/\s+/g, " ").trim()}
                      </div>
                    ) : null}
                  </div>
                  <span className="task-row-meta">
                    {tone === "overdue" ? <OverdueTag /> : null}
                    <span
                      className={t.deadline && !soon ? "text-muted" : !t.deadline ? "text-muted" : undefined}
                      style={{
                        fontSize: 12,
                        whiteSpace: "nowrap",
                        ...(soon && t.deadline
                          ? { color: "var(--color-accent-700)", fontWeight: 500 }
                          : {}),
                      }}
                    >
                      {fmtDue(t.deadline) ?? "—"}
                    </span>
                  </span>
                  <EffortDot task={t} />
                </div>
              );
            })}
            {backlog.length === 0 ? (
              <div
                className="text-muted"
                style={{
                  padding: "var(--row-pad-x)",
                  fontSize: 13,
                  borderBottom: recentDone.length > 0 ? "1px solid var(--color-divider)" : "none",
                }}
              >
                No open tasks.
              </div>
            ) : null}

            {recentDone.length > 0 ? (
              <>
                <h6
                  className="text-muted"
                  style={{ margin: 0, padding: "22px var(--row-pad-r) 6px var(--row-pad-l)", fontSize: 11 }}
                >
                  Recently completed
                </h6>
                {recentDone.map((t, i) => (
                  <div
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px var(--row-pad-r) 8px var(--row-pad-l)",
                      borderBottom:
                        i === recentDone.length - 1
                          ? "none"
                          : "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)",
                      cursor: "pointer",
                      opacity: 0.75,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-neutral-100)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                  >
                    <Square
                      checked
                      onToggle={() => toggleDone(t)}
                      label={`Mark "${t.title}" not done`}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 14,
                        textDecoration: "line-through",
                        color: "var(--color-neutral-500)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.title}
                    </span>
                    <span className="text-muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                      Done {fmtDue(t.completed_at)}
                    </span>
                  </div>
                ))}
              </>
            ) : null}
          </Blueprint>
        </div>
      </div>

      <TaskDrawer task={selected} onClose={() => setSelectedId(null)} />
    </div>
  );
}

function DayArrow({
  dir,
  onClick,
  disabled = false,
}: {
  dir: -1 | 1;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={dir === -1 ? "Previous day" : "Next day"}
      disabled={disabled}
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        padding: 2,
        display: "grid",
        cursor: disabled ? "default" : "pointer",
        color: disabled ? "var(--color-neutral-300)" : "var(--color-neutral-600)",
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points={dir === -1 ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
      </svg>
    </button>
  );
}
