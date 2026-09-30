"use client";

import { toast } from "sonner";
import { Effort, Task, api, patchTaskCache, revalidateAll } from "@/lib/api";
import { cn } from "@/lib/utils";

const EFFORT_BG: Record<Effort, string> = {
  short: "bg-effort-short",
  medium: "bg-effort-medium",
  long: "bg-effort-long",
};

const CYCLE: (Effort | null)[] = [null, "short", "medium", "long"];

export function EffortDot({ task, className }: { task: Task; className?: string }) {
  const effort = task.effort;
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
      className={cn(
        "size-3 flex-none cursor-pointer border p-0",
        effort ? cn(EFFORT_BG[effort], "border-transparent") : "border-neutral-400 bg-neutral-300",
        className
      )}
    />
  );
}
