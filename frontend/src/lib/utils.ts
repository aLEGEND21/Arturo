import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge tuned to this design system (app/globals.css):
// - Font sizes are always exact values like `text-[14px]`, which set only
//   font-size. Stock tailwind-merge assumes a size also sets line-height and
//   drops an earlier `leading-*`, which would lose e.g. a button's
//   `leading-[1.2]` when a caller shrinks its text.
// - The custom spacing tokens (`px-page`, `py-row-y`, ...) are registered so
//   overrides of them merge like any other spacing value.
const twMerge = extendTailwindMerge({
  override: {
    conflictingClassGroups: { "font-size": [] },
    conflictingClassGroupModifiers: { "font-size": [] },
  },
  extend: {
    theme: { spacing: ["page", "row-y", "row-x", "row-l", "row-r"] },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
