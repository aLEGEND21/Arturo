"use client";

import Link from "next/link";
import useSWR from "swr";
import { API_BASE, StatsSummary, fetcher } from "@/lib/api";

export function Nav() {
  const { data: stats } = useSWR<StatsSummary>("/api/stats/summary", fetcher, {
    refreshInterval: 60_000,
  });
  return (
    <header style={{ borderBottom: "1px solid var(--color-divider)" }}>
      <div className="nav mx-auto w-full max-w-[1280px]">
        <Link href="/" className="nav-brand">
          ARTURO DASHBOARD
        </Link>
        <span
          className="text-muted"
          style={{
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {stats
            ? `${stats.open_tasks} open · 7-day avg ${stats.seven_day_avg}/day`
            : "…"}
        </span>
        {/* The backend sets Content-Disposition, so a plain link downloads
            the file — no fetch, no blob, and it works both in dev (straight
            to the API origin) and behind the compose proxy. */}
        <a
          href={`${API_BASE}/api/export`}
          download
          className="btn btn-secondary"
          aria-label="Export tasks as JSON"
          title="Download today's list and every task ever, as JSON"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v12" />
            <polyline points="7 10 12 15 17 10" />
            <path d="M4 20h16" />
          </svg>
          <span className="btn-label">Export</span>
        </a>
      </div>
    </header>
  );
}
