"use client";

import { Fragment } from "react";
import { cn } from "@/lib/utils";

// Bare "www." hosts count too; only http(s) is ever matched, so a note can't
// smuggle in a javascript: href.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

/** Trims punctuation that ends a sentence rather than the URL, and a
 *  closing paren the URL never opened ("(see https://x.com/a)"). */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"]+$/, "");
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(/[.,;:!?'"]+$/, "");
  }
  return url;
}

type Part = { text: string; href?: string };

export function splitLinks(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (!url) continue;
    const start = m.index;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export const linkClass = "underline decoration-1 underline-offset-2 break-all";

/** Renders text with its URLs as links that open in a new tab. The rendered
 *  text is exactly `text`, character for character, which the notes field's
 *  click-to-caret mapping relies on. Link clicks stop propagating so a task
 *  row doesn't also open the drawer. */
export function Linkified({ text, className }: { text: string; className?: string }) {
  return (
    <>
      {splitLinks(text).map((p, i) =>
        p.href ? (
          <a
            key={i}
            href={p.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className={cn(linkClass, className)}
          >
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
    </>
  );
}
