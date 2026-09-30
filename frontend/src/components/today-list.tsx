"use client";

import { ReactNode, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Task, deadlineTone, fmtDue, fmtTime } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EffortDot } from "./effort-dot";
import { Blueprint, ClockIcon, DragDots, FlameIcon, OverdueTag, Square, Tag } from "./industry";
import {
  rowMetaClass,
  rowSubline,
  rowTextClass,
  rowTitle,
  spanBothLines,
  taskRowClass,
  trailingCell,
} from "./task-row";

// Done tasks show their completion time in the due slot on the right, so the
// subline only carries commitment/update context for open ones.
function subline(task: Task): string {
  const parts: string[] = [];
  if (task.state !== "done") {
    if (task.commitment_at) {
      parts.push(`Committed: ${fmtDue(task.commitment_at)}`);
    }
    if (task.last_user_update) {
      parts.push(`“${task.last_user_update}”`);
    }
  }
  if (task.notes) {
    parts.push(task.notes.replace(/\s+/g, " ").trim());
  }
  return parts.join(" · ");
}

function DragHandle({ className, ...props }: React.HTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      aria-label="Reorder"
      onClick={(e) => e.stopPropagation()}
      className={cn("grid cursor-grab touch-none border-none bg-transparent p-0", className)}
    >
      <DragDots />
    </button>
  );
}

export function TodayRow({
  task,
  onToggleDone,
  onOpen,
  dragHandleProps,
  isLast,
}: {
  task: Task;
  onToggleDone: (t: Task) => void;
  onOpen: (t: Task) => void;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  isLast?: boolean;
}) {
  const done = task.state === "done";
  const overdue = !done && deadlineTone(task.deadline) === "overdue";
  const soon = deadlineTone(task.deadline) !== "normal";
  const sub = subline(task);
  const stateChip = !done && !overdue && task.state !== "not_started";
  const hasChip = (!done && overdue) || stateChip || (!done && !!task.commitment_at);
  return (
    <div
      onClick={() => onOpen(task)}
      className={taskRowClass(
        "today",
        cn("cursor-pointer hover:bg-neutral-100", !isLast && "border-b border-divider")
      )}
    >
      {/* Done rows can't be dragged; a spacer keeps the checkbox column aligned. */}
      {dragHandleProps ? (
        <DragHandle {...dragHandleProps} className={spanBothLines} />
      ) : done ? (
        <span aria-hidden="true" className={cn("w-3.5 flex-none", spanBothLines)} />
      ) : (
        <DragDots className={spanBothLines} />
      )}
      <Square checked={done} onToggle={() => onToggleDone(task)} className={spanBothLines} />
      <div className={rowTextClass(3)}>
        <div
          className={cn(
            rowTitle,
            done ? "font-normal text-neutral-500 line-through" : "font-medium"
          )}
        >
          {task.title}
        </div>
        {sub ? <div className={rowSubline}>{sub}</div> : null}
      </div>
      <span className={rowMetaClass(3, hasChip)}>
        {!done && overdue ? <OverdueTag /> : null}
        {stateChip ? <Tag tone="accent">{task.state.replace("_", " ")}</Tag> : null}
        {!done && task.commitment_at ? (
          <Tag tone="neutral" className="gap-1">
            <ClockIcon />
            {fmtTime(task.commitment_at)}
          </Tag>
        ) : null}
        {done ? (
          <span className="text-[12px] whitespace-nowrap text-muted">
            {task.completed_at ? `Done ${fmtTime(task.completed_at)}` : "Done"}
          </span>
        ) : (
          <span
            className={cn(
              "text-[12px] whitespace-nowrap",
              task.deadline && soon ? "font-medium text-accent-700" : "text-muted"
            )}
          >
            {fmtDue(task.deadline) ?? "—"}
          </span>
        )}
      </span>
      <EffortDot task={task} className={trailingCell} />
    </div>
  );
}

function RecurringRow({
  task,
  onToggleDone,
  onOpen,
  dragHandleProps,
  isLast,
}: {
  task: Task;
  onToggleDone: (t: Task) => void;
  onOpen: (t: Task) => void;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  isLast?: boolean;
}) {
  const done = task.state === "done";
  return (
    <div
      onClick={() => onOpen(task)}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 py-[calc(var(--spacing-row-y)_-_1px)] pr-row-r pl-row-l hover:bg-neutral-100",
        !isLast && "border-b border-divider"
      )}
    >
      {dragHandleProps ? <DragHandle {...dragHandleProps} /> : <DragDots />}
      <Square checked={done} onToggle={() => onToggleDone(task)} />
      <div className="min-w-0 flex-1">
        <div className={cn(rowTitle, done && "text-neutral-500 line-through")}>{task.title}</div>
        {task.notes ? (
          <div className={rowSubline}>{task.notes.replace(/\s+/g, " ").trim()}</div>
        ) : null}
      </div>
      <Tag tone={done ? "accent" : "neutral"} className="gap-1">
        <FlameIcon />
        {task.streak + (done ? 1 : 0)}-day streak
      </Tag>
      <EffortDot task={task} />
    </div>
  );
}

function SortableItem({
  task,
  isLast,
  onToggleDone,
  onOpen,
  variant,
}: {
  task: Task;
  isLast: boolean;
  onToggleDone: (t: Task) => void;
  onOpen: (t: Task) => void;
  variant: "regular" | "recurring";
}) {
  // Completed regular tasks sit at the bottom by display rule, not position,
  // so dragging them would have nothing to persist.
  const locked = variant === "regular" && task.state === "done";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id, disabled: locked });
  const Row = variant === "regular" ? TodayRow : RecurringRow;
  return (
    <div
      ref={setNodeRef}
      className={cn("relative bg-canvas", isDragging && "z-10 opacity-35")}
      // dnd-kit drives the live drag position.
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <Row
        task={task}
        onToggleDone={onToggleDone}
        onOpen={onOpen}
        dragHandleProps={locked ? undefined : { ...attributes, ...listeners }}
        isLast={isLast}
      />
    </div>
  );
}

function DropZone({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={cn(isOver && "bg-accent-100")}>
      {children}
    </div>
  );
}

export function TodayBoards({
  regular,
  recurring,
  addRow,
  onToggleDone,
  onOpen,
  onReorderRegular,
  onReorderRecurring,
  onCrossMove,
}: {
  regular: Task[];
  recurring: Task[];
  addRow: ReactNode;
  onToggleDone: (t: Task) => void;
  onOpen: (t: Task) => void;
  onReorderRegular: (ids: number[]) => void;
  onReorderRecurring: (ids: number[]) => void;
  onCrossMove: (taskId: number, makeRecurring: boolean, orderedTargetIds: number[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  // Rendered in a DragOverlay so the row stays visible while crossing
  // between the regular and recurring sections.
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as number;
    setActiveTask(
      regular.find((t) => t.id === id) ?? recurring.find((t) => t.id === id) ?? null
    );
  }

  function containerOf(id: number | string): "regular" | "recurring" | null {
    if (id === "regular-zone") return "regular";
    if (id === "recurring-zone") return "recurring";
    if (regular.some((t) => t.id === id)) return "regular";
    if (recurring.some((t) => t.id === id)) return "recurring";
    return null;
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = active.id as number;
    const from = containerOf(activeId);
    const to = containerOf(over.id);
    if (!from || !to) return;

    if (from === to) {
      if (active.id === over.id) return;
      const list = from === "regular" ? regular : recurring;
      const oldIndex = list.findIndex((t) => t.id === activeId);
      const newIndex = list.findIndex((t) => t.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const ids = arrayMove(list, oldIndex, newIndex).map((t) => t.id);
      (from === "regular" ? onReorderRegular : onReorderRecurring)(ids);
      return;
    }

    // Cross-section drop: toggle recurring, inserting at the drop position.
    const target = to === "regular" ? regular : recurring;
    const overIndex = target.findIndex((t) => t.id === over.id);
    const ids = target.map((t) => t.id);
    ids.splice(overIndex < 0 ? ids.length : overIndex, 0, activeId);
    onCrossMove(activeId, to === "recurring", ids);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveTask(null)}
    >
      <Blueprint>
        <div className="flex flex-col">
          {addRow}
          <SortableContext items={regular.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <DropZone id="regular-zone">
              {regular.map((t, i) => (
                <SortableItem
                  key={t.id}
                  task={t}
                  variant="regular"
                  onToggleDone={onToggleDone}
                  onOpen={onOpen}
                  isLast={i === regular.length - 1}
                />
              ))}
              {regular.length === 0 ? (
                <div className="p-row-x text-[13px] text-muted">
                  Nothing on today&apos;s list yet.
                </div>
              ) : null}
            </DropZone>
          </SortableContext>
        </div>
      </Blueprint>

      <div className="mt-3">
        <h6 className="mt-0 mr-0 mb-2 ml-0 text-muted">
          Recurring — not counted above
        </h6>
        <Blueprint>
          <SortableContext items={recurring.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <DropZone id="recurring-zone">
              {recurring.map((t, i) => (
                <SortableItem
                  key={t.id}
                  task={t}
                  variant="recurring"
                  onToggleDone={onToggleDone}
                  onOpen={onOpen}
                  isLast={i === recurring.length - 1}
                />
              ))}
              {recurring.length === 0 ? (
                <div className="p-row-x text-[13px] text-muted">
                  Drag a task here to make it recurring.
                </div>
              ) : null}
            </DropZone>
          </SortableContext>
        </Blueprint>
      </div>

      <DragOverlay>
        {activeTask ? (
          <div className="border border-divider bg-canvas shadow-lg">
            {activeTask.recurring ? (
              <RecurringRow task={activeTask} onToggleDone={() => {}} onOpen={() => {}} isLast />
            ) : (
              <TodayRow task={activeTask} onToggleDone={() => {}} onOpen={() => {}} isLast />
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
