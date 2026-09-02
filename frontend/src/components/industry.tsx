"use client";

import { ReactNode, useState } from "react";

/* Shared primitives for the Industry design system (3a mockup). */

export function Blueprint({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`blueprint ${className ?? ""}`}
      style={{ background: "var(--color-bg)", ...style }}
    >
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      {children}
    </div>
  );
}

/* Red chip for past-due tasks; lineHeight 1 keeps the text truly centered. */
export function OverdueTag() {
  return (
    <span
      className="tag"
      style={{
        background: "#f8dcd8",
        color: "#8f261c",
        lineHeight: 1,
        // Optical centering: the text sits low with equal padding, so give
        // the bottom more room.
        padding: "3px 10px 4px",
      }}
    >
      overdue
    </span>
  );
}

/* 18px square checkbox from the mockup rows. */
export function Square({
  checked,
  onToggle,
  dashed = false,
  label,
}: {
  checked?: boolean;
  onToggle?: () => void;
  dashed?: boolean;
  label?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const base: React.CSSProperties = {
    width: 18,
    height: 18,
    flex: "none",
    display: "grid",
    placeItems: "center",
    cursor: onToggle ? "pointer" : undefined,
    padding: 0,
    background: checked ? "var(--color-accent)" : "transparent",
    border: checked
      ? "1.5px solid var(--color-accent)"
      : `1.5px ${dashed ? "dashed" : "solid"} var(--color-divider)`,
  };
  // Preview: a muted check on hover shows what clicking will do.
  const showPreview = !checked && hovered && !!onToggle;
  const inner =
    checked || showPreview ? (
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke={checked ? "var(--color-bg)" : "var(--color-neutral-400)"}
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ) : null;
  if (!onToggle) return <span style={base}>{inner}</span>;
  return (
    <button
      type="button"
      aria-label={label ?? (checked ? "Mark not done" : "Mark done")}
      style={base}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {inner}
    </button>
  );
}

/* Segmented control (.seg / .seg-opt). */
export function Seg<T extends string>({
  name,
  value,
  options,
  onChange,
  onDeselect,
  background,
  stretch = false,
}: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  onDeselect?: () => void;
  background?: string;
  stretch?: boolean;
}) {
  return (
    <div
      className="seg"
      style={{
        ...(background ? { background } : {}),
        ...(stretch ? { display: "flex", width: "100%" } : {}),
      }}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className="seg-opt"
          style={stretch ? { flex: 1, justifyContent: "center" } : undefined}
          onClick={() => {
            // Radios don't fire onChange when re-clicked; this is how a
            // selected option gets cleared.
            if (onDeselect && value === o.value) onDeselect();
          }}
        >
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/* — icons from the mockup — */

export const DragDots = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--color-neutral-400)"
    strokeWidth="1.5"
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
