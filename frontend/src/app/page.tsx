"use client";

import { useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { toast } from "sonner";
import { Task, api, deadlineTone, fetcher, fmtDue } from "@/lib/api";
import { BacklogAddRow, TodayAddRow } from "@/components/add-row";
import { EffortDot } from "@/components/effort-dot";
import { ContextStrip } from "@/components/context-strip";
import { Blueprint, Square } from "@/components/industry";
import { TaskDrawer, revalidateAll } from "@/components/task-drawer";
import { TodayBoards } from "@/components/today-list";

const TODAY_KEY = "/api/tasks?view=today";
const ALL_KEY = "/api/tasks?view=all";

export default function Dashboard() {
  const { data: todayTasks, error } = useSWR<Task[]>(TODAY_KEY, fetcher);
  const { data: allTasks } = useSWR<Task[]>(ALL_KEY, fetcher);
  const { mutate } = useSWRConfig();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const recurring = (todayTasks ?? []).filter((t) => t.recurring);
  const regular = (todayTasks ?? []).filter((t) => !t.recurring);
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

  const recentDone = useMemo(() => {
    const list = (allTasks ?? []).filter(
      (t) => !t.recurring && !t.today_flag && t.state === "done" && t.completed_at
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
    mutate(
      TODAY_KEY,
      (curr: Task[] | undefined) =>
        (curr ?? []).map((t) => (t.id === task.id ? { ...t, state: newState } : t)),
      { revalidate: false }
    );
    try {
      await api(`/api/tasks/${task.id}`, "PATCH", { state: newState });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      revalidateAll();
    }
  }

  async function reorderList(ids: number[], which: "regular" | "recurring") {
    const byId = new Map((todayTasks ?? []).map((t) => [t.id, t]));
    const moved = ids.map((id) => byId.get(id)!).filter(Boolean);
    const next = which === "regular" ? [...moved, ...recurring] : [...regular, ...moved];
    mutate(TODAY_KEY, next, { revalidate: false });
    try {
      await api("/api/tasks/reorder", "POST", { ids });
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
      await api("/api/tasks/reorder", "POST", { ids: orderedTargetIds });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
    } finally {
      revalidateAll();
    }
  }

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <div>
      <ContextStrip />

      {error ? (
        <div
          style={{
            margin: "14px 20px 0",
            padding: "9px 14px",
            border: "1px solid var(--color-divider)",
            fontSize: 13,
          }}
        >
          Can&apos;t reach the API — is the backend running on port 8000?
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 24,
          padding: 20,
        }}
      >
        {/* — Today column — */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h3 style={{ margin: 0 }}>Today</h3>
            <span className="text-muted" style={{ fontSize: 12 }}>
              {todayLabel}
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
              {doneCount}
              <span style={{ color: "var(--color-neutral-500)", fontSize: 16 }}>
                {" "}
                / {regular.length} done
              </span>
            </span>
          </div>

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
        </div>

        {/* — All tasks column — */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h3 style={{ margin: 0 }}>All tasks</h3>
            <span className="text-muted" style={{ fontSize: 12 }}>
              {backlog.length} open
            </span>
          </div>

          <Blueprint>
            <BacklogAddRow />
            {backlog.map((t, i) => {
              const soon = deadlineTone(t.deadline) !== "normal";
              return (
                <div
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 14px",
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
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 14,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.title}
                  </span>
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
                  <EffortDot task={t} />
                </div>
              );
            })}
            {backlog.length === 0 ? (
              <div
                className="text-muted"
                style={{
                  padding: 14,
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
                  style={{ margin: 0, padding: "10px 14px 6px", fontSize: 11 }}
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
                      padding: "8px 14px",
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
