"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { ContextNote, api, fetcher, fmtTime } from "@/lib/api";
import { BellOffIcon, Button } from "./industry";

// Compact ghost buttons that fit inside the banner's text line.
const pill = "px-2 py-0.5 text-[12px]";

export function ContextStrip() {
  const { data } = useSWR<ContextNote[]>("/api/context-notes", fetcher, {
    refreshInterval: 60_000,
  });
  const [hidden, setHidden] = useState<number[]>([]);
  const globals = (data ?? []).filter(
    (n) => n.scope === "global" && !hidden.includes(n.id)
  );
  if (globals.length === 0) return null;

  async function resume(id: number) {
    await api(`/api/context-notes/${id}`, "DELETE");
    mutate("/api/context-notes");
  }

  return (
    <div className="mx-page mt-3.5 flex flex-col gap-2">
      {globals.map((n) => (
        <div
          key={n.id}
          className="flex items-center gap-3 border border-accent-300 bg-accent-100 px-3.5 py-[9px]"
        >
          <BellOffIcon />
          <span className="text-[13px] text-accent-800">
            <strong>Paused — &ldquo;{n.text}.&rdquo;</strong>
            {n.expires_at
              ? ` Nudges resume at ${fmtTime(n.expires_at)}.`
              : " Paused until you resume."}
          </span>
          <span className="flex-1" />
          <Button variant="ghost" className={pill} onClick={() => resume(n.id)}>
            Resume now
          </Button>
          <Button variant="ghost" className={pill} onClick={() => setHidden((h) => [...h, n.id])}>
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}
