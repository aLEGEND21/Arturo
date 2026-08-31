"use client";

import { ReactNode } from "react";
import {
  DndContext,
  DragEndEvent,
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
import { EffortDot } from "./effort-dot";
import { Blueprint, ClockIcon, DragDots, FlameIcon, Square } from "./industry";

function subline(task: Task): React.ReactNode {
  if (task.state === "done" && task.completed_at) {
    return `Done ${fmtTime(task.completed_at)}`;
  }
  const parts: string[] = [];
  if (deadlineTone(task.deadline) === "overdue") {
    parts.push(`was due ${fmtDue(task.deadline, true)}`);
  } else if (task.deadline) {
    parts.push(`Due ${fmtDue(task.deadline, true)}`);
  }
  if (task.commitment_at) {
    parts.push(`Committed: ${fmtDue(task.commitment_at)}`);
  }
  if (task.last_user_update) {
    parts.push(`“${task.last_user_update}”`);
  }
  return parts.join(" · ") || "No deadline";
}

function DragHandle(props: React.HTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      aria-label="Reorder"
      onClick={(e) => e.stopPropagation()}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "grab",
        touchAction: "none",
        display: "grid",
      }}
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
  return (
    <div
      onClick={() => onOpen(task)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        borderBottom: isLast ? "none" : "1px solid var(--color-divider)",
        cursor: "pointer",
        background: overdue ? "var(--color-accent-100)" : undefined,
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = overdue
          ? "var(--color-accent-200)"
          : "var(--color-neutral-100)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = overdue ? "var(--color-accent-100)" : "")
      }
    >
      {dragHandleProps ? <DragHandle {...dragHandleProps} /> : <DragDots />}
      <Square checked={done} onToggle={() => onToggleDone(task)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: done ? 400 : 500,
            textDecoration: done ? "line-through" : undefined,
            color: done ? "var(--color-neutral-500)" : undefined,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.title}
        </div>
        <div
          className={overdue ? undefined : "text-muted"}
          style={{ fontSize: 11.5, color: overdue ? "var(--color-accent-800)" : undefined }}
        >
          {subline(task)}
        </div>
      </div>
      {!done && overdue ? (
        <span className="tag" style={{ background: "var(--color-accent-800)", color: "var(--color-accent-100)" }}>
          overdue
        </span>
      ) : null}
      {!done && !overdue && task.state !== "not_started" ? (
        <span className="tag tag-accent">{task.state.replace("_", " ")}</span>
      ) : null}
      {!done && task.commitment_at ? (
        <span className="tag tag-neutral" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <ClockIcon />
          {fmtTime(task.commitment_at)}
        </span>
      ) : null}
      {!done ? <EffortDot task={task} /> : null}
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
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        cursor: "pointer",
        borderBottom: isLast ? "none" : "1px solid var(--color-divider)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-neutral-100)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "")}
    >
      {dragHandleProps ? <DragHandle {...dragHandleProps} /> : <DragDots />}
      <Square checked={done} onToggle={() => onToggleDone(task)} />
      <span
        style={{
          flex: 1,
          fontSize: 14,
          textDecoration: done ? "line-through" : undefined,
          color: done ? "var(--color-neutral-500)" : undefined,
        }}
      >
        {task.title}
      </span>
      <span
        className={done ? "tag tag-accent" : "tag tag-neutral"}
        style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
      >
        <FlameIcon />
        {task.streak + (done ? 1 : 0)}-day streak
      </span>
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });
  const Row = variant === "regular" ? TodayRow : RecurringRow;
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : undefined,
        zIndex: isDragging ? 10 : undefined,
        position: "relative",
        background: "var(--color-bg)",
      }}
    >
      <Row
        task={task}
        onToggleDone={onToggleDone}
        onOpen={onOpen}
        dragHandleProps={{ ...attributes, ...listeners }}
        isLast={isLast}
      />
    </div>
  );
}

function DropZone({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ background: isOver ? "var(--color-accent-100)" : undefined }}
    >
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

  function containerOf(id: number | string): "regular" | "recurring" | null {
    if (id === "regular-zone") return "regular";
    if (id === "recurring-zone") return "recurring";
    if (regular.some((t) => t.id === id)) return "regular";
    if (recurring.some((t) => t.id === id)) return "recurring";
    return null;
  }

  function handleDragEnd(event: DragEndEvent) {
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
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
      <Blueprint>
        <div style={{ display: "flex", flexDirection: "column" }}>
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
                <div className="text-muted" style={{ padding: 14, fontSize: 13 }}>
                  Nothing on today&apos;s list yet.
                </div>
              ) : null}
            </DropZone>
          </SortableContext>
        </div>
      </Blueprint>

      <div>
        <h6 className="text-muted" style={{ margin: "0 0 8px" }}>
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
                <div className="text-muted" style={{ padding: 14, fontSize: 13 }}>
                  Drag a task here to make it recurring.
                </div>
              ) : null}
            </DropZone>
          </SortableContext>
        </Blueprint>
      </div>
    </DndContext>
  );
}
