/* Layout recipe for task rows (today list and all-tasks list).

   Chips and the due date sit to the right of the title on wide screens and
   drop below it on phones. On phones the row is a two-line grid: the title
   block and the meta cluster stack in the text column, while the leading
   controls and the effort dot span both lines so they stay centered against
   the whole row. */
import { cn } from "@/lib/utils";

export const rowPadding = "py-row-y pr-row-r pl-row-l";

/** The row itself. `cols` is its phone grid template. */
export function taskRowClass(cols: "backlog" | "today", className?: string) {
  return cn(
    "flex items-center gap-2.5 phone:grid phone:gap-x-2 phone:gap-y-0",
    cols === "today" ? "phone:grid-cols-[auto_auto_1fr_auto]" : "phone:grid-cols-[auto_1fr_auto]",
    rowPadding,
    className
  );
}

/** Leading controls (handle, checkbox): span both lines on phones. */
export const spanBothLines = "phone:row-[1/span_2]";

/** The trailing effort dot: both lines, last column. */
export const trailingCell = "phone:row-[1/span_2] phone:col-[-2]";

/** Title block. Tighter leading on phones pulls the lines closer. */
export function rowTextClass(col: 2 | 3) {
  return cn(
    "min-w-0 flex-1 phone:row-start-1 phone:*:leading-[1.35]",
    col === 2 ? "phone:col-start-2" : "phone:col-start-3"
  );
}

/** Chips + due date. On phones a line holding a chip gets 3px back above
 *  it, so the chip's box doesn't crowd the text; a plain date sits as close
 *  as the description does to the title. */
export function rowMetaClass(col: 2 | 3, hasChip: boolean) {
  return cn(
    "inline-flex items-center gap-2.5 phone:row-start-2 phone:leading-[1.35]",
    col === 2 ? "phone:col-start-2" : "phone:col-start-3",
    hasChip && "phone:mt-[3px]"
  );
}

export const rowTitle = "truncate text-[14px]";
export const rowSubline = "truncate text-[11.5px] text-muted";
