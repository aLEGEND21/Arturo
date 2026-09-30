/* Class recipes for the Industry design system, shared by client and server
   components (this module has no "use client", so server pages can call
   these too). The tokens they use are defined in app/globals.css. */
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const buttonBase = cva(
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-none border px-[12.24px] py-[6.8px] font-heading text-[14px] leading-[1.2] font-semibold no-underline disabled:cursor-not-allowed disabled:opacity-45",
  {
    variants: {
      variant: {
        primary:
          "border-accent bg-accent text-canvas hover:border-accent-700 hover:bg-accent-700 hover:text-canvas active:border-accent-800 active:bg-accent-800 active:text-canvas",
        secondary: "border-divider text-ink hover:bg-hover active:bg-press",
        ghost: "border-transparent px-[3.4px] text-accent hover:bg-accent-hover active:bg-accent-press",
      },
      size: {
        default: "",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  }
);

export type ButtonVariants = VariantProps<typeof buttonBase>;

/** Class string for anything that should look like a button, including
 *  links. Classes in `className` win over the variant's. */
export function buttonClass({ className, ...opts }: ButtonVariants & { className?: string } = {}) {
  return cn(buttonBase(opts), className);
}

/** Text inputs, textareas, and input-looking boxes. 16px on phones stops
 *  iOS Safari zooming into a focused control. */
export const inputClass =
  "w-full min-h-[36px] rounded-none border border-divider bg-surface px-2.5 py-1.5 text-[14px] text-ink caret-accent hover:border-divider-strong focus-visible:border-accent focus-visible:outline-offset-0 phone:text-[16px]";

/** Small uppercase accent label above a heading. */
export const kickerClass = "text-[10px] tracking-[0.1em] text-accent uppercase";
