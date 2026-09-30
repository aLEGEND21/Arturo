"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { Rule, api, fetcher } from "@/lib/api";
import { Blueprint, Button, Square } from "@/components/industry";
import { inputClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

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
    <div className="max-w-[720px] p-5">
      <div className="mb-1 flex items-baseline gap-3">
        <h3 className="m-0">Rules</h3>
        <span className="text-[12px] text-muted">
          standing instructions, injected verbatim · max 15 active
        </span>
      </div>

      {error ? (
        <div className="mt-3.5 border border-divider px-3.5 py-[9px] text-[13px]">
          Can&apos;t reach the API — is the backend running on port 8000?
        </div>
      ) : null}

      <div className="my-3.5 flex gap-2">
        <input
          className={inputClass}
          placeholder='e.g. "never nudge before noon on weekends"'
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addRule()}
        />
        <Button variant="primary" onClick={addRule} disabled={!text.trim()}>
          Add
        </Button>
      </div>

      <Blueprint>
        {(rules ?? []).map((r, i) => (
          <div
            key={r.id}
            className={cn(
              "flex items-center gap-2.5 px-3.5 py-2.5",
              i !== (rules ?? []).length - 1 && "border-b border-divider"
            )}
          >
            <Square checked={r.active} onToggle={() => toggle(r)} label={r.active ? "Deactivate rule" : "Activate rule"} />
            <span className={cn("flex-1 text-[14px]", !r.active && "text-neutral-500 line-through")}>
              {r.text}
            </span>
            <Button
              variant="ghost"
              className="px-2 py-0.5 text-[12px] text-neutral-600"
              onClick={() => remove(r)}
            >
              Delete
            </Button>
          </div>
        ))}
        {(rules ?? []).length === 0 ? (
          <div className="p-3.5 text-[13px] text-muted">No rules yet.</div>
        ) : null}
      </Blueprint>
    </div>
  );
}
