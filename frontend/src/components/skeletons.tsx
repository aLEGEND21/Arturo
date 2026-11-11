/* Loading placeholders shaped like the rows they stand in for. They reuse
   the real rows' layout recipes and line heights, so a list keeps its shape
   and the page doesn't jump when the data lands. */
import { cn } from "@/lib/utils";
import { Skeleton } from "./industry";
import {
  recurringRowClass,
  rowMetaClass,
  rowPadding,
  rowTextClass,
  spanBothLines,
  taskRowClass,
  trailingCell,
} from "./task-row";

/* As tall as one line of text at the element's font size (the body's 1.55
   leading), with the bar centered in it. A bare bar would be shorter than
   the text it replaces and the row would grow when the text arrives. */
const lineBox = "flex h-[1.55em] items-center";

/* Uneven on purpose: equal bars read as a table, not as a list of titles. */
const TITLE_WIDTHS = ["w-[58%]", "w-[36%]", "w-[71%]", "w-[47%]", "w-[63%]", "w-[29%]"];
const titleWidth = (i: number) => TITLE_WIDTHS[i % TITLE_WIDTHS.length];

type TaskRowKind = "today" | "backlog" | "recurring" | "history";

/* How many rows each list shows while it loads. A guess at a typical list;
   fixed per kind so the same list is the same height wherever it loads. */
const TASK_ROWS: Record<TaskRowKind, number> = { today: 4, recurring: 2, backlog: 6, history: 4 };

function TaskRowSkeleton({
  kind,
  index,
  isLast,
}: {
  kind: TaskRowKind;
  index: number;
  isLast: boolean;
}) {
  // Today and backlog rows become a two-line grid on phones (task-row.ts);
  // recurring and history rows are a single line everywhere.
  const grid = kind === "today" || kind === "backlog";
  const col = kind === "today" ? 3 : 2;
  const divider = cn(!isLast && "border-b border-divider");
  return (
    <div
      className={
        grid
          ? taskRowClass(kind, divider)
          : cn(
              kind === "recurring" ? recurringRowClass : cn("flex items-center gap-2.5", rowPadding),
              divider
            )
      }
    >
      {/* The drag handle's slot, left empty so the titles start where the
          real ones will. */}
      {kind === "today" || kind === "recurring" ? (
        <span className={cn("w-3.5 flex-none", grid && spanBothLines)} />
      ) : null}
      <Skeleton className={cn("size-[18px] flex-none", grid && spanBothLines)} />
      <div className={grid ? rowTextClass(col) : "min-w-0 flex-1"}>
        <div className={cn(lineBox, "text-[14px]", grid && "phone:h-[1.35em]")}>
          <Skeleton className={cn("h-[10px]", titleWidth(index))} />
        </div>
      </div>
      {kind === "recurring" ? (
        // The streak tag.
        <Skeleton className="h-[23px] w-[62px] flex-none" />
      ) : (
        // The due date, or a past day's status.
        <span className={grid ? rowMetaClass(col, false) : undefined}>
          <span className={cn(lineBox, "h-[1.35em] text-[12px]")}>
            <Skeleton className="h-[9px] w-[52px]" />
          </span>
        </span>
      )}
      {kind !== "history" ? (
        <Skeleton className={cn("size-3 flex-none", grid && trailingCell)} />
      ) : null}
    </div>
  );
}

export function TaskRowsSkeleton({ kind }: { kind: TaskRowKind }) {
  const rows = TASK_ROWS[kind];
  return (
    <div role="status" aria-label="Loading tasks">
      {Array.from({ length: rows }, (_, i) => (
        <TaskRowSkeleton key={i} kind={kind} index={i} isLast={i === rows - 1} />
      ))}
    </div>
  );
}

/* Rows of the rules page: checkbox, text, Delete. */
export function RuleRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading rules">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn(
            "flex items-center gap-2.5 px-3.5 py-2.5",
            i !== rows - 1 && "border-b border-divider"
          )}
        >
          <Skeleton className="size-[18px] flex-none" />
          <div className={cn(lineBox, "flex-1 text-[14px]")}>
            <Skeleton className={cn("h-[10px]", titleWidth(i))} />
          </div>
          <Skeleton className="mx-2 h-[9px] w-[34px]" />
        </div>
      ))}
    </div>
  );
}

/* Lines of the drawer's event history: a date column, then what happened.
   The font size comes from the list they sit in. */
export function EventRowsSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading event history">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn(
            "flex items-center gap-2.5 py-1.5",
            i !== rows - 1 && "border-b border-divider-soft"
          )}
        >
          <span className={cn(lineBox, "w-[120px] flex-none")}>
            <Skeleton className="h-[9px] w-[84px]" />
          </span>
          <Skeleton className={cn("h-[9px]", i % 2 ? "w-[72px]" : "w-[118px]")} />
        </div>
      ))}
    </div>
  );
}
