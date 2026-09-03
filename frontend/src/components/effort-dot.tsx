"use client";

import { toast } from "sonner";
import { Effort, Task, api, patchTaskCache, revalidateAll } from "@/lib/api";

const EFFORT_COLORS: Record<Effort, string> = {
  short: "#5c9d70",
  medium: "#d09c3e",
  long: "#bf5f50",
};

const CYCLE: (Effort | null)[] = [null, "short", "medium", "long"];

export function EffortDot({ task, size = 12 }: { task: Task; size?: number }) {
  const effort = task.effort;
  const color = effort ? EFFORT_COLORS[effort] : "var(--color-neutral-300)";
  const tooltip = effort
    ? `${effort} effort — click to change`
    : "no effort set — click to set";

  async function cycle(e: React.MouseEvent) {
    e.stopPropagation();
    const next = CYCLE[(CYCLE.indexOf(effort) + 1) % CYCLE.length];
    patchTaskCache(task.id, { effort: next });
    try {
      await api(`/api/tasks/${task.id}`, "PATCH", { effort: next });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
      revalidateAll();
    }
  }

  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      onClick={cycle}
      style={{
        width: size,
        height: size,
        flex: "none",
        padding: 0,
        cursor: "pointer",
        background: color,
        border: effort ? "1px solid transparent" : "1px solid var(--color-neutral-400)",
      }}
    />
  );
}
