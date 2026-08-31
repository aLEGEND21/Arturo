"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { Rule, api, fetcher } from "@/lib/api";
import { Blueprint, Square } from "@/components/industry";

export default function RulesPage() {
  const { data: rules, error } = useSWR<Rule[]>("/api/rules", fetcher);
  const [text, setText] = useState("");

  async function addRule() {
    const t = text.trim();
    if (!t) return;
    try {
      await api("/api/rules", "POST", { text: t });
      setText("");
      mutate("/api/rules");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add rule");
    }
  }

  async function toggle(rule: Rule) {
    await api(`/api/rules/${rule.id}`, "PATCH", { active: !rule.active });
    mutate("/api/rules");
  }

  async function remove(rule: Rule) {
    try {
      await api(`/api/rules/${rule.id}`, "DELETE");
      toast("Rule deleted");
      mutate("/api/rules");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Rules</h3>
        <span className="text-muted" style={{ fontSize: 12 }}>
          standing instructions, injected verbatim · max 15 active
        </span>
      </div>

      {error ? (
        <div style={{ margin: "14px 0 0", padding: "9px 14px", border: "1px solid var(--color-divider)", fontSize: 13 }}>
          Can&apos;t reach the API — is the backend running on port 8000?
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, margin: "14px 0" }}>
        <input
          className="input"
          placeholder='e.g. "never nudge before noon on weekends"'
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addRule()}
        />
        <button className="btn btn-primary" onClick={addRule} disabled={!text.trim()}>
          Add
        </button>
      </div>

      <Blueprint>
        {(rules ?? []).map((r, i) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              borderBottom:
                i === (rules ?? []).length - 1 ? "none" : "1px solid var(--color-divider)",
            }}
          >
            <Square checked={r.active} onToggle={() => toggle(r)} label={r.active ? "Deactivate rule" : "Activate rule"} />
            <span
              style={{
                flex: 1,
                fontSize: 14,
                textDecoration: r.active ? undefined : "line-through",
                color: r.active ? undefined : "var(--color-neutral-500)",
              }}
            >
              {r.text}
            </span>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: "2px 8px", color: "var(--color-neutral-600)" }}
              onClick={() => remove(r)}
            >
              Delete
            </button>
          </div>
        ))}
        {(rules ?? []).length === 0 ? (
          <div className="text-muted" style={{ padding: 14, fontSize: 13 }}>
            No rules yet.
          </div>
        ) : null}
      </Blueprint>
    </div>
  );
}
