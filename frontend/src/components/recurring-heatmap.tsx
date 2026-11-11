"use client";

import { useState } from "react";
import useSWR from "swr";
import { HeatmapDay, HeatmapStatus, Task, TaskState, fetcher } from "@/lib/api";
import { cn } from "@/lib/utils";

/* Week columns the server sends (HEATMAP_WEEKS in backend/app/routers/
   tasks.py), used here only to draw the placeholder before the data
   arrives. Change both together. */
const WEEKS = 26;
/* A drawer narrower than 400px (a phone) shows only the newest weeks, so
   the tiles stay big enough to read and tap. This follows the drawer's own
   width with a container query rather than the viewport's `phone:`: the
   drawer is already full width well below 768px. Tailwind needs the class
   names spelled out, so the 400px lives in these three strings. */
const NARROW_WEEKS = 17;
const hideWhenNarrow = "@max-[400px]:hidden";
const hideWhenWide = "hidden @max-[400px]:inline";
/* Tooltips open rightward from a tile, except in the last columns, where
   they open leftward: either way they stay inside the drawer's scrolling
   body, which would clip them (or grow a scrollbar). */
const TIP_FLIP_COLS = 10;

/* Stepped in lightness so the states also read without color. Days before
   the task existed are a darker grey than days it wasn't started: they are
   left out of the completion figures, and the grid has to show which days
   those figures count. */
const tileClass: Record<HeatmapStatus, string> = {
  absent: "bg-neutral-300",
  not_started: "bg-neutral-200",
  in_progress: "bg-accent-400",
  done: "bg-accent",
};

const statusLabel: Record<HeatmapStatus, string> = {
  absent: "No task yet",
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
};

const legend: HeatmapStatus[] = ["absent", "not_started", "in_progress", "done"];

/** Mirror of `_heat_status` in backend/app/routers/tasks.py. Change both
 *  together. */
function liveStatus(state: TaskState): HeatmapStatus {
  if (state === "done") return "done";
  if (state === "in_progress" || state === "blocked") return "in_progress";
  return "not_started";
}

// Heatmap dates are bare logical days; parse them as local midnight so the
// weekday and label match the date as written, whatever the browser's zone.
const parseDay = (iso: string) => new Date(`${iso}T00:00:00`);
const monthName = (iso: string) => parseDay(iso).toLocaleDateString(undefined, { month: "short" });

/* Both the month row and the tiles: one equal-width column per week, as
   many as there are visible weeks, so the grid always spans the drawer. */
const weekColumns = "grid grid-flow-col auto-cols-fr gap-[3px]";

/* A recurring task's last six months as a commit-graph style grid: one
   column per week, Sunday at the top, today the last tile. */
export function RecurringHeatmap({ task }: { task: Task }) {
  // Temporary tasks (negative ids) don't exist on the server yet.
  const { data } = useSWR<HeatmapDay[]>(
    task.id > 0 ? `/api/tasks/${task.id}/heatmap` : null,
    fetcher
  );
  const [hovered, setHovered] = useState<number | null>(null);

  // The last day is today. Draw it from the task itself so a state change
  // shows at once, like every other optimistic patch, without a refetch.
  const days = (data ?? []).map((d, i, all) =>
    i === all.length - 1 ? { ...d, status: liveStatus(task.state) } : d
  );
  // The server starts the list on a Sunday; the offset keeps the rows right
  // if it ever doesn't.
  const offset = days.length ? parseDay(days[0].date).getDay() : 0;
  const cols = data ? Math.ceil((offset + days.length) / 7) : WEEKS;
  const firstNarrowCol = cols - NARROW_WEEKS;
  const colOf = (i: number) => Math.floor((offset + i) / 7);

  // A month is named above the week its 1st falls in. The first visible
  // week also gets its month, unless one starts so soon after that the two
  // names would touch.
  const monthStart = new Map<number, string>();
  days.forEach((d, i) => {
    if (parseDay(d.date).getDate() === 1) monthStart.set(colOf(i), monthName(d.date));
  });
  const edgeMonth = (col: number) => {
    for (let c = col; c < col + 3; c++) if (monthStart.has(c)) return null;
    const day = days[Math.max(0, col * 7 - offset)];
    return day ? monthName(day.date) : null;
  };

  // Completion over the days shown from week `fromCol` on. Days before the
  // task existed don't count, and neither does today until it's done: a day
  // still under way isn't a miss yet.
  const completion = (fromCol: number) => {
    const counted = days.filter(
      (d, i) =>
        colOf(i) >= fromCol &&
        d.status !== "absent" &&
        (i < days.length - 1 || d.status === "done")
    );
    const done = counted.filter((d) => d.status === "done").length;
    return { done, total: counted.length };
  };
  const stats = (fromCol: number) => {
    const { done, total } = completion(fromCol);
    if (!total) return null;
    return (
      <>
        <span className="font-medium text-ink">{Math.round((100 * done) / total)}%</span> · {done}/{total} days
      </>
    );
  };
  const all = completion(0);

  return (
    <div className="@container">
      {/* Styled like a Field label; not a Field because the text depends on
          the container width. */}
      <div className="mb-[5px] flex items-baseline justify-between gap-3 text-[12px] text-label">
        <span>
          <span className={hideWhenNarrow}>Last 6 months</span>
          <span className={hideWhenWide}>Last 4 months</span>
        </span>
        {/* The figures cover the weeks on screen, so a narrow drawer gets
            its own. */}
        <span className="whitespace-nowrap text-muted tabular-nums">
          <span className={hideWhenNarrow}>{stats(0)}</span>
          <span className={hideWhenWide}>{stats(firstNarrowCol)}</span>
        </span>
      </div>

      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-1 text-[10px] leading-none text-muted">
        <div />
        <div className={cn(weekColumns, "h-[10px]")}>
          {Array.from({ length: cols }, (_, col) => (
            <div key={col} className={cn("min-w-0 whitespace-nowrap", col < firstNarrowCol && hideWhenNarrow)}>
              {monthStart.get(col) ??
                (col === 0 ? (
                  edgeMonth(col)
                ) : col === firstNarrowCol ? (
                  <span className={hideWhenWide}>{edgeMonth(col)}</span>
                ) : null)}
            </div>
          ))}
        </div>

        <div aria-hidden className="grid grid-rows-7 gap-[3px]">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <span key={i} className="flex items-center justify-center">
              {d}
            </span>
          ))}
        </div>
        <div
          role="img"
          aria-label={
            data
              ? `Last ${days.length} days: done on ${all.done} of ${all.total}`
              : "Loading history"
          }
          className={cn(weekColumns, "grid-rows-7")}
          onMouseLeave={() => setHovered(null)}
        >
          {data ? (
            <>
              {Array.from({ length: offset }, (_, i) => (
                <div key={`pad-${i}`} className={cn(firstNarrowCol > 0 && hideWhenNarrow)} />
              ))}
              {days.map((d, i) => {
                const col = colOf(i);
                return (
                  <div
                    key={d.date}
                    // Touch browsers send mouseenter on tap, so a tap shows
                    // the tooltip too.
                    onMouseEnter={() => setHovered(i)}
                    className={cn(
                      "relative aspect-square border border-divider-soft",
                      tileClass[d.status],
                      hovered === i && "border-divider-strong",
                      col < firstNarrowCol && hideWhenNarrow
                    )}
                  >
                    {hovered === i ? (
                      <div
                        className={cn(
                          "pointer-events-none absolute bottom-full z-10 mb-[5px] bg-neutral-900 px-2 py-1 text-[11px] leading-[1.3] whitespace-nowrap text-canvas shadow-lg",
                          cols - 1 - col < TIP_FLIP_COLS ? "-right-px" : "-left-px"
                        )}
                      >
                        {parseDay(d.date).toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                        <span className="text-neutral-400"> · {statusLabel[d.status]}</span>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </>
          ) : (
            // Empty tiles in the final shape, so the fields below don't jump
            // when the data lands.
            Array.from({ length: WEEKS * 7 }, (_, i) => (
              <div
                key={i}
                className={cn(
                  "aspect-square border border-divider-soft",
                  tileClass.not_started,
                  Math.floor(i / 7) < firstNarrowCol && hideWhenNarrow
                )}
              />
            ))
          )}
        </div>
      </div>

      <ul className="mt-2 mb-0 flex list-none flex-wrap justify-center gap-x-3 gap-y-1.5 p-0 text-[11px] leading-none text-muted">
        {legend.map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className={cn("size-[11px] flex-none border border-divider-soft", tileClass[s])} />
            {statusLabel[s]}
          </li>
        ))}
      </ul>
    </div>
  );
}
