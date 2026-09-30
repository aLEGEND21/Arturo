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
import {
  rowMetaClass,
  rowSubline,
  rowTextClass,
  rowTitle,
  spanBothLines,
  taskRowClass,
  trailingCell,
} from "@/components/task-row";
import { cn } from "@/lib/utils";

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
        <div className="mx-page mt-3.5 border border-divider px-3.5 py-[9px] text-[13px]">
          Can&apos;t reach the API — is the backend running on port 8000?
        </div>
      ) : null}

      {/* Two columns; stacks Today above All tasks on phones */}
      <div className="grid grid-cols-[1fr_1fr] gap-6 px-page py-5 phone:grid-cols-[1fr]">
        {/* — Today column — */}
        {/* min-w-0 lets long nowrap notes truncate instead of widening the 1fr track */}
        <div className="flex min-w-0 flex-col gap-3.5">
          <div className="relative flex items-baseline gap-3">
            <h3 className="m-0">{heading}</h3>
            {/* Absolutely centered in the column so the arrows stay put no
                matter how wide the day name or counter is. */}
            <span className="absolute top-1/2 left-1/2 inline-flex -translate-1/2 items-center gap-[3px]">
              <DayArrow dir={-1} onClick={() => goToOffset(dayOffset - 1)} />
              <span className="w-[76px] text-center text-[12px] text-muted">{dateLabel}</span>
              <DayArrow
                dir={1}
                disabled={dayOffset === 0}
                onClick={() => goToOffset(dayOffset + 1)}
              />
            </span>
            <span className="flex-1" />
            <span className="font-heading text-[22px] leading-[1.12] font-semibold text-accent-700">
              {shownDone}
              <span className="text-[16px] text-neutral-500"> / {shownTotal} done</span>
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
              <div className="p-row-x text-[13px] text-muted">Loading…</div>
            </Blueprint>
          )}
        </div>

        {/* — All tasks column — */}
        <div className="flex min-w-0 flex-col gap-3.5">
          <div className="flex items-baseline gap-3">
            <h3 className="m-0">All tasks</h3>
            <span className="text-[12px] text-muted">{backlog.length} open</span>
          </div>

          <Blueprint>
            <BacklogAddRow />
            {backlog.map((t, i) => {
              const tone = deadlineTone(t.deadline);
              const soon = tone !== "normal";
              const overdue = tone === "overdue";
              return (
                <div
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={taskRowClass(
                    "backlog",
                    cn(
                      "cursor-pointer hover:bg-neutral-100",
                      !(i === backlog.length - 1 && recentDone.length === 0) && "border-b border-divider"
                    )
                  )}
                >
                  <Square
                    checked={t.state === "done"}
                    onToggle={() => toggleDone(t)}
                    label={`Mark "${t.title}" done`}
                    className={spanBothLines}
                  />
                  <div className={rowTextClass(2)}>
                    <div className={cn(rowTitle, "font-medium")}>{t.title}</div>
                    {t.notes ? (
                      <div className={rowSubline}>{t.notes.replace(/\s+/g, " ").trim()}</div>
                    ) : null}
                  </div>
                  <span className={rowMetaClass(2, overdue)}>
                    {overdue ? <OverdueTag /> : null}
                    <span
                      className={cn(
                        "text-[12px] whitespace-nowrap",
                        soon && t.deadline ? "font-medium text-accent-700" : "text-muted"
                      )}
                    >
                      {fmtDue(t.deadline) ?? "—"}
                    </span>
                  </span>
                  <EffortDot task={t} className={trailingCell} />
                </div>
              );
            })}
            {backlog.length === 0 ? (
              <div className={cn("p-row-x text-[13px] text-muted", recentDone.length > 0 && "border-b border-divider")}>
                No open tasks.
              </div>
            ) : null}

            {recentDone.length > 0 ? (
              <>
                <h6 className="m-0 pt-[22px] pr-row-r pb-1.5 pl-row-l text-[11px] text-muted">
                  Recently completed
                </h6>
                {recentDone.map((t, i) => (
                  <div
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 py-2 pr-row-r pl-row-l opacity-75 hover:bg-neutral-100",
                      i !== recentDone.length - 1 && "border-b border-divider-soft"
                    )}
                  >
                    <Square
                      checked
                      onToggle={() => toggleDone(t)}
                      label={`Mark "${t.title}" not done`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-neutral-500 line-through">
                      {t.title}
                    </span>
                    <span className="text-[12px] whitespace-nowrap text-muted">
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
      className={cn(
        "grid border-none bg-transparent p-0.5",
        disabled ? "cursor-default text-neutral-300" : "cursor-pointer text-neutral-600"
      )}
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
