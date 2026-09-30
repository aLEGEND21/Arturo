"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { type ButtonVariants, buttonClass } from "@/lib/ui";

/* Shared primitives for the Industry design system (3a mockup), built from
   the Tailwind theme in globals.css. Class recipes that server components
   also need (buttons, inputs, kicker) live in lib/ui.ts. */

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & ButtonVariants) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...props} />;
}

/** A labelled form row. */
export function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label className="mb-[5px] block text-[12px] text-label">{label}</label>
      {children}
    </div>
  );
}

/* — blueprint frame — */

const corner =
  "pointer-events-none absolute size-[11px] text-muted before:absolute before:top-0 before:left-[5px] before:h-full before:w-px before:bg-current after:absolute after:top-[5px] after:left-0 after:h-px after:w-full after:bg-current";

export function Blueprint({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative rounded-none border border-divider bg-canvas", className)}>
      <i className={cn(corner, "-top-1.5 -left-1.5")} />
      <i className={cn(corner, "-top-1.5 -right-1.5")} />
      <i className={cn(corner, "-bottom-1.5 -left-1.5")} />
      <i className={cn(corner, "-right-1.5 -bottom-1.5")} />
      {children}
    </div>
  );
}

/* — tags — */

const tagTones = {
  accent: "bg-accent-100 text-accent-800",
  neutral: "bg-neutral-100 text-neutral-800",
};

export function Tag({
  tone,
  className,
  children,
}: {
  tone: keyof typeof tagTones;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-none px-2.5 py-[3px] text-[11px] tracking-[0.02em] whitespace-nowrap",
        tagTones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/* Red chip for past-due tasks. leading-none keeps the text truly centered;
   the text still sits low, so the bottom padding is a pixel larger. */
export function OverdueTag() {
  return (
    <span className="inline-flex items-center rounded-none bg-danger-bg px-2.5 pt-[3px] pb-1 text-[11px] leading-none tracking-[0.02em] whitespace-nowrap text-danger">
      overdue
    </span>
  );
}

/* 18px square checkbox from the mockup rows. Hovering an unchecked,
   clickable square previews the check in a muted stroke. */
export function Square({
  checked,
  onToggle,
  dashed = false,
  label,
  className,
}: {
  checked?: boolean;
  onToggle?: () => void;
  dashed?: boolean;
  label?: string;
  className?: string;
}) {
  const box = cn(
    "group grid size-[18px] flex-none place-items-center border-[1.5px] p-0",
    checked ? "border-accent bg-accent" : cn("border-divider bg-transparent", dashed && "border-dashed"),
    onToggle && "cursor-pointer",
    className
  );
  const check = (preview: boolean) => (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={preview ? "var(--color-neutral-400)" : "var(--color-canvas)"}
      strokeWidth="2.5"
      strokeLinecap="round"
      className={preview ? "hidden group-hover:block" : undefined}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
  if (!onToggle) return <span className={box}>{checked ? check(false) : null}</span>;
  return (
    <button
      type="button"
      aria-label={label ?? (checked ? "Mark not done" : "Mark done")}
      className={box}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {check(!checked)}
    </button>
  );
}

/* Segmented control: a radio group drawn as joined buttons. */
export function Seg<T extends string>({
  name,
  value,
  options,
  onChange,
  onDeselect,
  stretch = false,
}: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  onDeselect?: () => void;
  stretch?: boolean;
}) {
  return (
    <div
      className={cn(
        "inline-flex overflow-hidden rounded-none border border-divider",
        stretch && "flex w-full"
      )}
    >
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <label
            key={o.value}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 px-3 py-[7px] text-[13px] not-first:border-l not-first:border-divider",
              "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent",
              selected ? "bg-accent text-canvas" : "hover:bg-hover",
              stretch && "flex-1 justify-center"
            )}
            onClick={() => {
              // Radios don't fire onChange when re-clicked; this is how a
              // selected option gets cleared.
              if (onDeselect && selected) onDeselect();
            }}
          >
            <input
              type="radio"
              name={name}
              checked={selected}
              onChange={() => onChange(o.value)}
              className="pointer-events-none absolute h-0 w-0 opacity-0"
            />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

/* — icons from the mockup — */

export const DragDots = ({ className }: { className?: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--color-neutral-400)"
    strokeWidth="1.5"
    className={className}
  >
    <circle cx="9" cy="5" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="19" r="1" />
    <circle cx="15" cy="5" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="19" r="1" />
  </svg>
);

export const PlusIcon = ({ stroke }: { stroke?: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke={stroke ?? "currentColor"}
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const ClockIcon = ({ size = 11 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

export const FlameIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  </svg>
);

export const CloseIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const CheckIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const CalendarIcon = ({ size = 12 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <rect x="3" y="4" width="18" height="18" rx="0" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

export const BellOffIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--color-accent-700)"
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);
