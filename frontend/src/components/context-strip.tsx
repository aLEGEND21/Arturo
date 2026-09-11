"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { ContextNote, api, fetcher, fmtTime } from "@/lib/api";
import { BellOffIcon } from "./industry";

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
    <div style={{ margin: "14px var(--page-pad-x) 0", display: "flex", flexDirection: "column", gap: 8 }}>
      {globals.map((n) => (
        <div
          key={n.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "9px 14px",
            background: "var(--color-accent-100)",
            border: "1px solid var(--color-accent-300)",
          }}
        >
          <BellOffIcon />
          <span style={{ fontSize: 13, color: "var(--color-accent-800)" }}>
            <strong>Paused — &ldquo;{n.text}.&rdquo;</strong>
            {n.expires_at
              ? ` Nudges resume at ${fmtTime(n.expires_at)}.`
              : " Paused until you resume."}
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: "2px 8px" }}
            onClick={() => resume(n.id)}
          >
            Resume now
          </button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: "2px 8px" }}
            onClick={() => setHidden((h) => [...h, n.id])}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
